# RPE Recorder 渲染插件（rpe-recorder）

Yunzai-Bot 插件：QQ 群内自动代录 RPE 谱面视频。发送 `#rpe recorder` → 发预设 → 发谱面包 → 自动渲染并发送视频。

## 文件说明

| 文件 | 说明 |
|------|------|
| `rpeRecorder.js` | 插件主文件（放入 Yunzai `plugins/` 目录） |
| `render.bat` | 渲染脚本（放入 RPE Recorder 软件目录，被插件调用）——由本插件作者编写，不含 RPE Recorder 软件本体 |

> 注：本包**不含** RPE Recorder 软件本体（.exe 等）——软件本体属部署方自有环境，不随包分发。

## 安装

1. **插件文件**：将 `rpeRecorder.js` 放到 Yunzai-Bot 的 `plugins/rpe-recorder/` 目录（没有则创建）
2. **渲染脚本**：将 `render.bat` 放到 **RPE Recorder 软件目录**（如 `E:\...\RPE Recorder\render.bat`）
3. **依赖软件**：需本机安装 **RPE Recorder**（谱面录制软件，自带 ffmpeg）
4. **修改路径**：打开 `rpeRecorder.js` 顶部，把 `RPE_DIR` 改成你实际的 RPE Recorder 目录：
   ```js
   const RPE_DIR = 'E:\\HugoMoveData\\User\\lenovo\\Downloads\\RPE Recorder'
   ```
5. 重启 Yunzai 或等热更新（`[修改插件]` 日志出现即生效）

## 使用方法

```
#rpe recorder          → 开始（120 秒内有效）
  ↓ 发预设文件（二选一）：
  .set 预设            → 录制台 Ctrl+S 导出
  settings.txt         → 录制台 Ctrl+Shift+S 导出（推荐，可自定义渲染参数）
  ↓ 发谱面包：
  .pez / .zip          → 谱面包（含 .json/.pec 谱面 + 音频 + 曲绘）
  ↓ 自动完成：
  渲染 → 自动 @ 发起人 + 发视频（QQ 头像/昵称）
```

## 特性

- 多人排队渲染（队列隔离任务目录，互不干扰）
- 自动使用发起人 QQ 头像 + 昵称（头像自动转 png）
- 歌名含 `:` `/` `*` 等非法字符自动清洗（输出文件名）
- 谱面带 shader（extra.json）自动确认启用
- 渲染失败自动附带 RPE 日志（log.txt）
- 支持 .json / .pec 谱面格式

## 依赖环境（本机部署需要）

| 组件 | 说明 |
|------|------|
| Yunzai-Bot（TRSS） | 插件宿主 |
| NapCat（OneBot v11） | 提供 HTTP API `http://127.0.0.1:3000`（get_group_root_files / get_group_file_url / get_stranger_info / send_group_msg） |
| RPE Recorder | 谱面录制软件（含 ffmpeg） |
| 视频发送 | 需 NapCat 容器可访问视频文件（本机部署通过 scp 到容器挂载目录 `/app/napcat/config/`） |

## 注意

- `settings.txt` 使用 **UTF-8 编码**（RPE Recorder 按 UTF-8 读取）
- 头像必须 **png 格式**（RPE Recorder 不支持 jpg 头像，插件已自动转换）
