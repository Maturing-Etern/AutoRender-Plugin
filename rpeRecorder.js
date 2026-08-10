/**
 * RPE Recorder 渲染插件（指令模式）
 *  - 群里发 #rpe → 进入等待状态 → 发送 .pez 文件 → 自动渲染
 *  - 流程：下载 .pez → 解压到 file/ → 生成 settings.txt → 运行 RPE Recorder.exe
 *  - 完成信号：轮询 Output/ 新 mp4 或进程退出
 */
import plugin from '../../lib/plugins/plugin.js'
import logger from './components/Logger.js'
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

// ==================== RPE Recorder 路径 ====================
const RPE_DIR = 'E:\\HugoMoveData\\User\\lenovo\\Downloads\\RPE Recorder'
const FILE_DIR = path.join(RPE_DIR, 'file')      // 输入文件目录
const OUTPUT_DIR = path.join(RPE_DIR, 'Output')  // 输出视频目录
const TEMP_DIR = path.join(RPE_DIR, 'temp')      // 临时目录
const RENDER_BAT = path.join(RPE_DIR, 'render.bat')

/** 渲染超时（分钟） */
const RENDER_TIMEOUT_MIN = 30
/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 2 * 60 * 1000
/** 等待文件超时（秒） */
const WAIT_FILE_TIMEOUT = 120

/** 是否正在渲染 */
let rendering = false
/** 渲染队列：{ e, files }（多人请求排队，一个接一个渲染） */
const renderQueue = []
/** .set 预设解析出的渲染参数（渲染时传给 render.bat） */
let parsedSet = null
/** settings.txt 模板模式标记（用户直发 settings.txt 时 true，渲染只重写谱面字段） */
let settingsTemplate = false
/** 等待文件会话：key = 群_用户 → { step: 'set'|'pez', expire } */
const waitingSet = new Map() // key: `${groupId}_${userId}` → { step, expire }

export class rpeRecorder extends plugin {
  constructor() {
    super({
      name: 'RPE渲染',
      dsc: '#rpe recorder 两步式：先发 .set 预设 → 再发 .pez 谱面包自动渲染视频',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: /^#?rpe\s+recorder\s*$/i, fnc: 'startCmd' },
        { reg: /^[\s\S]*$/, fnc: 'receive' },
      ],
    })
  }

  /** #rpe 指令：进入等待 .set 预设文件状态 */
  async startCmd() {
    const e = this.e
    if (rendering) {
      e.reply('当前有渲染任务进行中，请稍后再试')
      return true
    }
    const key = this.sessionKey(e)
    logger.mark(`[RPE] startCmd key="${key}" group=${e.group_id} user=${e.user_id}`)
    settingsTemplate = false
    waitingSet.set(key, { step: 'set', expire: Date.now() + WAIT_FILE_TIMEOUT * 1000 })
    e.reply('请先发送预设文件（.set 或 settings.txt，120 秒内有效。这两种文件分别可以在群文件的录制台，使用Ctrl+S和Ctrl+Shift+S导出，推荐后者）')
    return true
  }

  /** 万能匹配：检查是否收到 .pez 文件 */
  async receive() {
    const e = this.e
    if (!e) return false

    // 调试：打印收到的消息段类型
    const types = Array.isArray(e.message) ? e.message.map(m => m?.type) : []
    logger.debug(`[RPE] 收到消息: isGroup=${e.isGroup} types=${JSON.stringify(types)}`)

    // 先提取文件段（非文件消息一律静默，不拦截任何人）
    const fileSegs = Array.isArray(e.message) ? e.message.filter(m => m?.type === 'file') : []
    if (fileSegs.length === 0) return false

    // 渲染中：只对等待状态的文件消息提示（别人的消息静默）
    if (rendering) {
      const key0 = this.sessionKey(e)
      if (waitingSet.has(key0)) {
        e.reply('当前有渲染任务进行中，请稍后再试')
      }
      return false
    }

    const key = this.sessionKey(e)
    const w = waitingSet.get(key)
    logger.mark(`[RPE] receive key="${key}" has=${waitingSet.has(key)} w=${JSON.stringify(w)}`)
    const waiting = w && w.expire > Date.now()
    if (!waiting) {
      // 没在等待状态：静默忽略（不打扰群里别人发文件）
      return false
    }
    const step = w.step || 'set'

    for (const seg of fileSegs) {
      const segData = seg.data || seg
      const fileName = seg.name || segData.name || segData.file?.name ||
        (typeof segData.file === 'string' && path.basename(segData.file)) ||
        path.basename(segData.url || seg.url || 'file')
      const fileId = segData.id || (typeof segData.file === 'string' && segData.file) || ''
      const low = fileName.toLowerCase()
      logger.mark(`[RPE] 调试: step=${step} fileName="${fileName}" seg=${JSON.stringify(seg).slice(0, 200)}`)
      // 第一步：settings.txt 渲染参数模板（直发模式——渲染时只重写谱面相关字段）
      if (step === 'set' && low.endsWith('settings.txt')) {
        try {
          let setUrl = seg.url || ''
          if (!setUrl) setUrl = await this.resolveFileUrl(e, seg, fileId, fileName)
          if (!setUrl) {
            e.reply('无法获取 settings.txt 下载链接，请重试')
            waitingSet.delete(key)
            return true
          }
          const savePath = path.join(RPE_DIR, 'settings.txt')
          await Bot.download(setUrl, savePath)
          logger.info(`[RPE] settings.txt 模板已保存: ${savePath}`)
          // 校验 settings.txt 格式（key:value 行 + 关键字段）
          try {
            const txt = fs.readFileSync(savePath, 'utf-8')
            const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(l => l && l.includes(':') && !l.startsWith('#'))
            if (lines.length < 5) throw new Error(`内容行太少（${lines.length} 行），需要 key:value 格式`)
            const keys = lines.map(l => l.split(':')[0].trim())
            const required = ['fps', 'width', 'height', 'chart_name', 'audio_name']
            const missing = required.filter(k => !keys.includes(k))
            if (missing.length) throw new Error('缺少字段: ' + missing.join(' / '))
            settingsTemplate = true
            parsedSet = null
            waitingSet.set(key, { step: 'pez', expire: Date.now() + WAIT_FILE_TIMEOUT * 1000 })
            e.reply('✅ settings.txt 已接收并校验通过（渲染参数模板）！请发送谱面包（.pez/.zip 文件，120 秒内有效）')
          } catch (e2) {
            logger.error(`[RPE] settings.txt 校验失败: ${e2.message}`)
            e.reply('❌ settings.txt 校验失败：' + e2.message + '，请检查文件格式后重试 #rpe render')
            waitingSet.delete(key)
          }
        } catch (err) {
          logger.error(`[RPE] settings.txt 保存失败: ${err.message}`)
          e.reply('settings.txt 保存失败：' + err.message + '，请重试 #rpe render')
          waitingSet.delete(key)
        }
        return true
      }
      // 第一步：.set 预设文件
      if (step === 'set' && low.endsWith('.set')) {
        settingsTemplate = false
        try {
          let setUrl = seg.url || ''
          if (!setUrl) setUrl = await this.resolveFileUrl(e, seg, fileId, fileName)
          if (!setUrl) {
            e.reply('无法获取 .set 文件下载链接，请重试')
            waitingSet.delete(key)
            return true
          }
          const savePath = path.join(RPE_DIR, 'save1.set')
          await Bot.download(setUrl, savePath)
          logger.info(`[RPE] 预设文件已保存: ${savePath}`)
          // 解析 .set 的渲染参数（fps/分辨率/码率/offset 等），供渲染时传给 render.bat
          try {
            const setJson = JSON.parse(fs.readFileSync(savePath, 'utf-8'))
            const t = v => v?.text ?? v
            parsedSet = {
              fps: t(setJson.fps),
              width: t(setJson.width),
              height: t(setJson.height),
              videoQuality: t(setJson.videoQuality),
              audioBitrate: t(setJson.audioBitrate),
              begin: t(setJson.beginSecond_2),
              end: t(setJson.endSecond_2),
              addOffset: t(setJson.addOffset),
            }
            logger.info(`[RPE] 预设渲染参数: ${JSON.stringify(parsedSet)}`)
          } catch (e2) {
            parsedSet = null
            logger.warn(`[RPE] .set 解析失败（用默认渲染参数）: ${e2.message}`)
            e.reply('⚠️ 预设文件解析失败（' + e2.message + '），将使用默认渲染参数继续，请发送谱面包')
          }
          // 进入第二步：等 .pez
          waitingSet.set(key, { step: 'pez', expire: Date.now() + WAIT_FILE_TIMEOUT * 1000 })
          e.reply('✅ 预设文件（.set）读取成功！请发送谱面包（.pez 文件，120 秒内有效）')
        } catch (err) {
          logger.error(`[RPE] 预设保存失败: ${err.message}`)
          e.reply('预设保存失败：' + err.message + '，请重试 #rpe')
          waitingSet.delete(key)
        }
        return true
      }
      // 第二步：.pez/.zip 谱面包
      if (step === 'pez' && (low.endsWith('.pez') || low.endsWith('.zip'))) {
        waitingSet.delete(key)
        await this.handlePez(e, seg)
        return true
      }
      e.reply(`当前应发送 ${step === 'set' ? '.set 预设文件' : '.pez 谱面包'}，请重试`)
    }
    return true
  }

  /** 会话 key */
  sessionKey(e) {
    return e.isGroup ? `${e.group_id}_${e.user_id}` : `private_${e.user_id}`
  }

  /** 处理 .pez 文件 */
  async handlePez(e, seg) {
    const segData = seg.data || seg
    // 兼容 TRSS 文件段结构：{id, name, size, busid, type} 或 {file:{name,url}}
    const fileName = seg.name || segData.name || segData.file?.name ||
      (typeof segData.file === 'string' && path.basename(segData.file)) ||
      path.basename(segData.url || seg.url || 'file')
    const fileUrl = segData.url || seg.url || ''
    const fileId = segData.id || (typeof segData.file === 'string' && segData.file) || ''

    if (!['.pez', '.zip'].some(x => fileName.toLowerCase().endsWith(x))) {
      e.reply('仅支持 .pez / .zip 谱面包文件')
      return
    }

    try {
      // 1. 下载 .pez（优先直接 url；QQ 文件段无 url 时尝试通过 bot API 获取）
      const pezPath = path.join(TEMP_DIR, 'chart.pez')
      let dlUrl = fileUrl
      if (!dlUrl && fileId) {
        dlUrl = await this.resolveFileUrl(e, seg, fileId, fileName)
      }
      if (!dlUrl) {
        e.reply('无法获取文件下载链接（QQ 文件段无 url），请改用官方渠道或重试')
        return
      }
      const dl = await Bot.download(dlUrl, pezPath)
      logger.info(`[RPE] 已下载 .pez (${dl.buffer?.length || '?'} bytes)`)
      e.reply(`收到谱面包 ${fileName}（${((dl.buffer?.length || 0) / 1024 / 1024).toFixed(1)}MB），开始渲染`)

      // 2. 解压 .pez 到任务专属目录（队列任务互不干扰——file/temp 不共用）
      const taskId = String(Date.now())
      const taskFileDir = path.join(FILE_DIR, taskId)
      fs.mkdirSync(taskFileDir, { recursive: true })
      const extracted = await this.extractPez(pezPath, taskFileDir)
      logger.info(`[RPE] 解压完成: ${JSON.stringify(extracted)} 目录=${taskId}`)

      // 3. 加入渲染队列（多人请求排队，一个接一个渲染）
      renderQueue.push({ e, files: extracted, useTemplate: settingsTemplate, taskId })
      if (renderQueue.length === 1 && !rendering) {
        e.reply('开始渲染...')
      } else {
        e.reply(`已加入渲染队列（前面还有 ${renderQueue.length - 1} 个任务），完成后自动发送视频`)
      }
      this.processQueue()
    } catch (err) {
      logger.error(`[RPE] 处理失败: ${err.stack || err.message}`)
      logger.error(`[RPE] 文件段结构: ${JSON.stringify(seg).slice(0, 500)}`)
      e.reply('处理失败：' + err.message)
    }
  }

  /** 渲染队列消费：空闲时取出队头渲染，完成后自动继续下一个 */
  async processQueue() {
    if (rendering || renderQueue.length === 0) return
    const task = renderQueue.shift()
    rendering = true
    try {
      await this.render(task.e, task.files, task.useTemplate, task.taskId)
    } finally {
      rendering = false
      this.processQueue()
    }
  }

  /** 尝试通过 NapCat HTTP API 获取 QQ 文件下载链接（群文件列表按文件名匹配 → get_group_file_url） */
  async resolveFileUrl(e, seg, fileId, fileName) {
    const apiBase = 'http://127.0.0.1:3000'
    const groupId = e.group_id
    const busid = seg.busid || 104
    try {
      // 1. 群文件列表 → 按文件名找到真实 file_id
      const files = await this.napcatApi(apiBase, 'get_group_root_files', { group_id: groupId })
      const filesList = files?.data?.files || []
      const match = filesList.find(f => f.file_name === fileName)
      const realFileId = match?.file_id || fileId
      logger.info(`[RPE] 群文件匹配: ${fileName} → ${realFileId}`)
      // 2. get_group_file_url 拿下载链接
      const r = await this.napcatApi(apiBase, 'get_group_file_url', {
        group_id: groupId, file_id: realFileId, busid: match?.busid || busid,
      })
      const url = r?.data?.url || ''
      if (url) logger.info(`[RPE] 文件下载 URL 已获取`)
      return url
    } catch (err) {
      logger.error(`[RPE] 解析文件 URL 失败: ${err.message}`)
      return ''
    }
  }

  /** 调用 NapCat HTTP API（带超时/空响应处理/重试） */
  async napcatApi(base, action, params) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      try {
        const res = await fetch(`${base}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        })
        const text = await res.text()
        if (!text) {
          logger.warn(`[RPE] API ${action} 空响应（第${attempt}次）`)
          continue
        }
        const data = JSON.parse(text)
        logger.info(`[RPE] API ${action} 成功（${text.length}字节）`)
        return data
      } catch (err) {
        logger.warn(`[RPE] API ${action} 失败（第${attempt}次）: ${err.message}`)
      } finally {
        clearTimeout(timer)
      }
    }
    return null
  }

  /** 解压 .pez（zip 格式）到目标目录 */
  async extractPez(pezPath, destDir) {
    // 用 python 解压（Windows 自带 zipfile）——写到临时 .py 再执行（cmd 里多行 -c 不可靠）
    const script = `
import zipfile, sys, json
z = zipfile.ZipFile(r'${pezPath}')
names = z.namelist()
z.extractall(r'${destDir}')
info = {}
for n in names:
    low = n.lower()
    if low.endswith(('.json', '.pec')): info['chart'] = n
    elif low.endswith(('.mp3', '.wav', '.m4a', '.ogg', '.flac')): info['audio'] = n
    elif low.endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp')): info['picture'] = n
    elif low.endswith('info.txt'): info['info'] = n
print(json.dumps(info, ensure_ascii=False))
`
    const pyFile = path.join(TEMP_DIR, 'rpe_extract.py')
    fs.writeFileSync(pyFile, script, 'utf-8')
    const { stdout } = await execAsync(`python "${pyFile}"`, { timeout: 60000 })
    const info = JSON.parse(stdout.trim())
    if (!info.chart) throw new Error('.pez 内未找到谱面文件（.json/.pec）')

    // 读取 info.txt 补充元数据（兼容 CRLF 换行）
    let meta = {}
    if (info.info) {
      const txt = fs.readFileSync(path.join(destDir, info.info), 'utf-8')
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^(\w+):\s*(.*)$/)
        if (m) meta[m[1]] = m[2].trim()
      }
    }
    return { ...info, meta }
  }

  /** 自动写入发起人 QQ 头像 + 昵称到 settings.txt（head_sculpture / player_name） */
  async updatePlayerProfile(e, taskId = '') {
    const userId = String(e.user_id)
    const settingsPath = path.join(RPE_DIR, 'settings.txt')
    if (!fs.existsSync(settingsPath)) return
    const taskDir = taskId ? path.join(FILE_DIR, taskId) : FILE_DIR
    if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true })
    try {
      // 0. 先拿 uin（数字 QQ）+ 昵称——qlogo 头像 url 需要数字 uin（e.user_id 可能是 uid u_ 开头）
      let uin = userId
      let nickname = userId
      try {
        const ri = await this.napcatApi('http://127.0.0.1:3000', 'get_stranger_info', { user_id: userId })
        uin = String(ri?.data?.uin || userId)
        nickname = ri?.data?.nickname || userId
        logger.info(`[RPE] QQ 信息: uid=${userId} uin=${uin} nick=${nickname}`)
      } catch (err) {
        logger.warn(`[RPE] QQ 信息获取失败: ${err.message}`)
      }
      // 1. 下载 QQ 头像并探测真实格式（q1.qlogo.cn 可能返回 jpg/webp）
      const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`
      let headExt = 'png'
      try {
        const tmpPath = path.join(taskDir, '头像.tmp')
        await Bot.download(avatarUrl, tmpPath)
        const buf = fs.readFileSync(tmpPath).subarray(0, 4)
        if (buf[0] === 0xFF && buf[1] === 0xD8) headExt = 'jpg'
        else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) headExt = 'png'
        else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) headExt = 'webp'
        const finalHead = path.join(taskDir, `头像.${headExt}`)
        if (finalHead !== tmpPath) fs.renameSync(tmpPath, finalHead)
        // RPE Recorder 只支持 png 头像——非 png 用自带 ffmpeg 转 png
        if (headExt !== 'png') {
          const headPng = path.join(taskDir, '头像.png')
          await execAsync(`"${path.join(RPE_DIR, 'ffmpeg.exe')}" -y -i "${finalHead}" "${headPng}"`, { timeout: 30000 })
          headExt = 'png'
        }
        logger.info(`[RPE] QQ 头像已就绪（png）: uin=${uin}`)
      } catch (err) {
        logger.warn(`[RPE] QQ 头像处理失败: ${err.message}`)
      }
      // 3. 写 settings.txt（head_sculpture 指向任务目录内实际格式的头像）——UTF-8（RPE Recorder 读 UTF-8）
      const headField = taskId ? `head_sculpture:file/${taskId}/头像.${headExt}` : `head_sculpture:file/头像.${headExt}`
      let txt = fs.readFileSync(settingsPath, 'utf-8')
      txt = txt.replace(/^head_sculpture:.*$/m, headField)
      txt = txt.replace(/^player_name:.*$/m, `player_name:${nickname}`)
      fs.writeFileSync(settingsPath, txt, 'utf-8')
      logger.info(`[RPE] settings.txt 已写入 QQ 头像/昵称（UTF-8）`)
    } catch (err) {
      logger.warn(`[RPE] 更新玩家信息失败: ${err.message}`)
    }
  }

  /** 渲染主流程：调 render.bat + 轮询 Output 目录 / 进程状态 */
  async render(e, files, useTemplate = false, taskId = '') {
    try {
      // 1. 记录渲染开始前的 Output 文件快照
      const beforeSnapshot = this.outputSnapshot()

      // 1.2 创建任务专属 temp 目录（temp/<taskId>/）
      if (taskId) fs.mkdirSync(path.join(TEMP_DIR, taskId), { recursive: true })

      // 1.5 自动写入发起人 QQ 头像 + 昵称到任务专属目录（file/<taskId>/）
      await this.updatePlayerProfile(e, taskId)

      // 2. 调用 render.bat（环境变量传参，避免特殊字符转义问题）
      const meta = files.meta || {}
      const songName = meta.Name || 'Untitled'
      const batEnv = {
        ...process.env,
        RPE_TITLE: songName,
        RPE_CHART: files.chart,
        RPE_AUDIO: files.audio || '',
        RPE_PIC: files.picture || '',
        RPE_LEVEL: meta.Level || 'IN Lv.1',
        RPE_COMPOSE: meta.Composer || '',
        RPE_CHARTER: meta.Charter || '',
        RPE_LENGTH: meta.Length || '',
        // .set 预设的渲染参数（未提供则 render.bat 用默认值）
        RPE_FPS: parsedSet?.fps || '60',
        RPE_WIDTH: parsedSet?.width || '1620',
        RPE_HEIGHT: parsedSet?.height || '1080',
        RPE_VIDEO_QUALITY: parsedSet?.videoQuality || '30',
        RPE_AUDIO_BITRATE: parsedSet?.audioBitrate || '320',
        RPE_BEGIN: parsedSet?.begin || '0',
        RPE_END: parsedSet?.end || meta.Length || '180',
        RPE_ADD_OFFSET: parsedSet?.addOffset || '70',
        // settings.txt 模板模式：render.bat 只重写谱面相关字段（file_dir/temp_dir/illustration/chart/audio/output_path）
        RPE_USE_TEMPLATE: useTemplate ? '1' : '',
        // 任务专属目录（队列隔离：file/<taskId>/、temp/<taskId>/）
        RPE_TASK_DIR: taskId || '',
      }
      logger.info(`[RPE] 调用 render.bat: ${songName} / ${files.chart}`)
      const { stdout, stderr } = await execAsync(`cmd /c "${RENDER_BAT}"`, { cwd: RPE_DIR, env: batEnv, timeout: 30000 })
      logger.info(`[RPE] render.bat 输出: ${(stdout || stderr).slice(0, 500)}`)

      // 2.5 自动确认 shader 弹窗（谱面带 extra.json 时 RPE Recorder 弹窗询问，默认开启——自动按回车）
      this.autoConfirmShader()

      // 3. 轮询完成信号（Output 出现新 mp4 或 RPE Recorder.exe 退出）
      const startTime = Date.now()
      let recorderGone = false

      while (Date.now() - startTime < RENDER_TIMEOUT_MIN * 60 * 1000) {
        await this.sleep(POLL_INTERVAL)

        // 完成信号 1：Output 出现新 mp4
        const newMp4 = this.findNewOutput(beforeSnapshot, songName)
        if (newMp4) {
          logger.info(`[RPE] 检测到新输出: ${newMp4}`)
          // 等文件写完（大小稳定）
          await this.waitFileStable(newMp4)
          await this.sendVideo(e, newMp4)
          return
        }

        // 完成信号 2：RPE Recorder.exe 进程已退出
        if (!recorderGone && !(await this.isRecorderRunning())) {
          recorderGone = true
          logger.info('[RPE] RPE Recorder.exe 已退出，等待输出落盘...')
          await this.sleep(POLL_INTERVAL)
          const mp4 = this.findNewOutput(beforeSnapshot, songName)
          if (mp4) {
            await this.waitFileStable(mp4)
            await this.sendVideo(e, mp4)
            return
          }
          throw new Error('渲染进程退出但未找到输出视频，可能失败')
        }

        logger.info(`[RPE] 轮询中... 已耗时 ${Math.round((Date.now() - startTime) / 60000)} 分钟`)
      }

      throw new Error(`渲染超时（${RENDER_TIMEOUT_MIN} 分钟）`)
    } catch (err) {
      logger.error(`[RPE] 渲染失败: ${err.stack || err.message}`)
      // 采集 RPE Recorder 日志（谱面报错在 log.txt）
      let rpeLog = ''
      for (const lp of [path.join(RPE_DIR, 'temp', 'log.txt'), path.join(TEMP_DIR, taskId, 'log.txt')]) {
        try {
          if (fs.existsSync(lp)) {
            const c = fs.readFileSync(lp, 'utf-8').trim()
            if (c) rpeLog = c.split('\n').slice(-6).join('\n')
          }
        } catch { /* ignore */ }
      }
      e.reply('渲染失败：' + err.message + (rpeLog ? '\n【RPE日志】\n' + rpeLog : '（无 RPE 日志，可能软件崩溃）'))
    }
  }

  /** 渲染完成后自动发送视频：scp 到 VM → 复制进容器挂载目录 → NapCat HTTP API 发群消息 */
  async sendVideo(e, mp4Path) {
    const vmUser = 'napcat'
    const vmHost = 'localhost'
    const vmPort = 2222
    const remoteTmp = '/tmp/rpe_video.mp4'
    const remoteName = 'rpe_' + Date.now() + '.mp4'
    const remoteFinal = '/opt/napcat/config/' + remoteName
    try {
      e.reply('渲染完成！正在上传视频...')
      // 1. scp 视频到 VM
      await execAsync(`scp -P ${vmPort} -o StrictHostKeyChecking=no "${mp4Path}" ${vmUser}@${vmHost}:${remoteTmp}`, { timeout: 120000 })
      // 2. 复制进容器挂载目录（NapCat 可读）
      await execAsync(`ssh -p ${vmPort} -o StrictHostKeyChecking=no ${vmUser}@${vmHost} "sudo cp ${remoteTmp} ${remoteFinal} && sudo rm -f ${remoteTmp}"`, { timeout: 60000 })
      // 3. NapCat HTTP API 发视频到原会话（群里 @ 发起人）
      const videoSeg = { type: 'video', data: { file: '/app/napcat/config/' + remoteName } }
      const message = e.isGroup
        ? {
            group_id: String(e.group_id),
            message: [
              { type: 'at', data: { qq: String(e.user_id) } },
              { type: 'text', data: { text: ' 渲染完成！视频已出 ✅' } },
              videoSeg,
            ],
          }
        : { user_id: String(e.user_id), message: [videoSeg] }
      const res = await fetch('http://127.0.0.1:3000/' + (e.isGroup ? 'send_group_msg' : 'send_private_msg'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
      })
      const r = await res.json()
      logger.info(`[RPE] 视频发送结果: ${JSON.stringify(r).slice(0, 150)}`)
      if (r?.status === 'ok') {
        e.reply('渲染完成！视频已发送 ✅')
      } else {
        e.reply('渲染完成！但视频发送失败：' + (r?.message || '未知错误'))
      }
    } catch (err) {
      logger.error(`[RPE] 视频发送失败: ${err.message}`)
      e.reply('渲染完成！但视频发送失败：' + err.message + '（视频在：' + mp4Path + '）')
    }
  }

  /** 检查 RPE Recorder.exe 是否在运行 */
  async isRecorderRunning() {
    try {
      const { stdout } = await execAsync('tasklist /fi "ImageName eq RPE Recorder.exe" /nh')
      return stdout.includes('RPE Recorder.exe')
    } catch {
      return false
    }
  }

  /** 自动确认 RPE Recorder 的 shader 弹窗（每 5 秒对窗口按 Enter，最多 60 秒；弹窗默认按钮=开启） */
  async autoConfirmShader() {
    for (let i = 0; i < 12; i++) {
      try {
        await execAsync(`powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; if ($ws.AppActivate('RPE Recorder')) { $ws.SendKeys('{ENTER}'); Write-Output 'sent' }"`, { timeout: 10000 })
        logger.info(`[RPE] shader 弹窗自动确认（第${i + 1}次）`)
      } catch { /* RPE Recorder 未启动时忽略 */ }
      await this.sleep(5000)
    }
  }

  /** 渲染前的 Output 目录快照（文件名→修改时间，用于检测同名覆盖的新文件） */
  outputSnapshot() {
    if (!fs.existsSync(OUTPUT_DIR)) return {}
    const snap = {}
    for (const f of fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4'))) {
      snap[f] = fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs
    }
    return snap
  }

  /** 找渲染后新增/更新的 mp4（优先同名或最新修改） */
  findNewOutput(beforeSnapshot, songName) {
    if (!fs.existsSync(OUTPUT_DIR)) return null
    const now = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4'))
    // 新文件：不存在于快照，或修改时间比快照新（同名覆盖也算）
    const newFiles = now.filter(f => !(f in beforeSnapshot) || fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs > beforeSnapshot[f])
    if (newFiles.length === 0) return null
    // 优先同名，否则取最新修改的
    const match = newFiles.find(f => f.startsWith(songName)) ||
      newFiles.sort((a, b) => fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs - fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs)[0]
    return path.join(OUTPUT_DIR, match)
  }

  /** 等待文件大小稳定（渲染完成写入完毕） */
  async waitFileStable(filePath) {
    let lastSize = -1
    for (let i = 0; i < 5; i++) {
      await this.sleep(5000)
      const size = fs.statSync(filePath).size
      if (size === lastSize && size > 0) return
      lastSize = size
    }
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }
}
