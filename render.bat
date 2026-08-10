@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ============================================================
REM  RPE Recorder render script
REM  Mode 1 (env vars, recommended, no escaping issues):
REM    set RPE_TITLE=SongName & set RPE_CHART=chart.json & set RPE_AUDIO=song.mp3
REM    set RPE_PIC=cover.png & set RPE_LEVEL=IN Lv.16 & set RPE_COMPOSE=Composer
REM    set RPE_CHARTER=Charter & set RPE_LENGTH=181.629
REM    render.bat
REM  Mode 2 (command line args):
REM    render.bat "SongName" "chart.json" "song.mp3" "cover.png" "IN Lv.16" "Composer" "Charter" "181.629"
REM  Flow: update settings.txt -> launch RPE Recorder.exe
REM ============================================================

if defined RPE_CHART (
    set "TITLE=%RPE_TITLE%"
    set "CHART=%RPE_CHART%"
    set "AUDIO=%RPE_AUDIO%"
    set "PIC=%RPE_PIC%"
    set "LEVEL=%RPE_LEVEL%"
    set "COMPOSE=%RPE_COMPOSE%"
    set "CHARTER=%RPE_CHARTER%"
    set "LENGTH=%RPE_LENGTH%"
) else (
    set "TITLE=%~1"
    set "CHART=%~2"
    set "AUDIO=%~3"
    set "PIC=%~4"
    set "LEVEL=%~5"
    set "COMPOSE=%~6"
    set "CHARTER=%~7"
    set "LENGTH=%~8"
)

if "%CHART%"=="" (
    echo [ERROR] missing chart filename
    exit /b 1
)

echo [1/2] updating settings.txt ...

set "CHART=%CHART:\=/%"
set "AUDIO=%AUDIO:\=/%"
set "PIC=%PIC:\=/%"

REM .set render params (optional, defaults below)
if not defined RPE_FPS set "RPE_FPS=60"
if not defined RPE_WIDTH set "RPE_WIDTH=1620"
if not defined RPE_HEIGHT set "RPE_HEIGHT=1080"
if not defined RPE_VIDEO_QUALITY set "RPE_VIDEO_QUALITY=30"
if not defined RPE_AUDIO_BITRATE set "RPE_AUDIO_BITRATE=320"
if not defined RPE_BEGIN set "RPE_BEGIN=0"
if not defined RPE_END set "RPE_END=%LENGTH%"
if not defined RPE_ADD_OFFSET set "RPE_ADD_OFFSET=70"

if defined RPE_USE_TEMPLATE (
REM Template mode: user-supplied settings.txt, only rewrite chart-related fields
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$f='settings.txt';" ^
  "$enc=New-Object System.Text.UTF8Encoding($false);" ^
  "$c=[System.IO.File]::ReadAllText((Resolve-Path $f), $enc);" ^
  "$c=$c -replace '(?m)^file_dir:.*$', ('file_dir:file/' + $env:RPE_TASK_DIR);" ^
  "$c=$c -replace '(?m)^temp_dir:.*$', ('temp_dir:temp/' + $env:RPE_TASK_DIR);" ^
  "$c=$c -replace '(?m)^chart_name:.*$', ('chart_name:file/' + $env:RPE_TASK_DIR + '/' + $env:CHART);" ^
  "$c=$c -replace '(?m)^audio_name:.*$', ('audio_name:file/' + $env:RPE_TASK_DIR + '/' + $env:AUDIO);" ^
  "$c=$c -replace '(?m)^illustration_name:.*$', ('illustration_name:file/' + $env:RPE_TASK_DIR + '/' + $env:PIC);" ^
  "$outName = ($env:TITLE -replace '[\\\\/:*?<>|]', '_');" ^
  "$c=$c -replace '(?m)^output_path:.*$', ('output_path:' + (Get-Location).Path + '/Output/' + $outName + '.mp4');" ^
  "[System.IO.File]::WriteAllText((Resolve-Path $f), $c, $enc);" ^
  "Write-Output 'settings.txt updated (template mode)'"
) else (
REM Full mode: rewrite all render params from env vars
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$f='settings.txt';" ^
  "$enc=New-Object System.Text.UTF8Encoding($false);" ^
  "$c=[System.IO.File]::ReadAllText((Resolve-Path $f), $enc);" ^
  "$c=$c -replace '(?m)^file_dir:.*$', ('file_dir:file/' + $env:RPE_TASK_DIR);" ^
  "$c=$c -replace '(?m)^temp_dir:.*$', ('temp_dir:temp/' + $env:RPE_TASK_DIR);" ^
  "$c=$c -replace '(?m)^chart_name:.*$', ('chart_name:file/' + $env:RPE_TASK_DIR + '/' + $env:CHART);" ^
  "$c=$c -replace '(?m)^audio_name:.*$', ('audio_name:file/' + $env:RPE_TASK_DIR + '/' + $env:AUDIO);" ^
  "$c=$c -replace '(?m)^illustration_name:.*$', ('illustration_name:file/' + $env:RPE_TASK_DIR + '/' + $env:PIC);" ^
  "$outName = ($env:TITLE -replace '[\\\\/:*?<>|]', '_');" ^
  "$c=$c -replace '(?m)^output_path:.*$', ('output_path:' + (Get-Location).Path + '/Output/' + $outName + '.mp4');" ^
  "$c=$c -replace '(?m)^title:.*$', ('title:' + $env:TITLE);" ^
  "$c=$c -replace '(?m)^compose:.*$', ('compose:' + $env:COMPOSE);" ^
  "$c=$c -replace '(?m)^chart:.*$', ('chart:' + $env:CHARTER);" ^
  "$c=$c -replace '(?m)^difficulty_text:.*$', ('difficulty_text:' + $env:LEVEL);" ^
  "$c=$c -replace '(?m)^end_second:.*$', ('end_second:' + $env:RPE_END);" ^
  "$c=$c -replace '(?m)^fps:.*$', ('fps:' + $env:RPE_FPS);" ^
  "$c=$c -replace '(?m)^width:.*$', ('width:' + $env:RPE_WIDTH);" ^
  "$c=$c -replace '(?m)^height:.*$', ('height:' + $env:RPE_HEIGHT);" ^
  "$c=$c -replace '(?m)^quality:.*$', ('quality:' + $env:RPE_VIDEO_QUALITY);" ^
  "$c=$c -replace '(?m)^audio_bitrate:.*$', ('audio_bitrate:' + $env:RPE_AUDIO_BITRATE);" ^
  "$c=$c -replace '(?m)^begin_second:.*$', ('begin_second:' + $env:RPE_BEGIN);" ^
  "$c=$c -replace '(?m)^add_offset:.*$', ('add_offset:' + $env:RPE_ADD_OFFSET);" ^
  "[System.IO.File]::WriteAllText((Resolve-Path $f), $c, $enc);" ^
  "Write-Output 'settings.txt updated (GBK)'"
)

if errorlevel 1 (
    echo [ERROR] failed to update settings.txt
    exit /b 1
)

echo [2/2] launching RPE Recorder.exe ...
start "" "%~dp0RPE Recorder.exe"

echo [OK] render started, output dir: %~dp0Output
exit /b 0
