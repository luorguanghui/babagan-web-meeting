@echo off
setlocal
set "MEETING_EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%MEETING_EDGE%" set "MEETING_EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%MEETING_EDGE%" set "MEETING_EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%MEETING_EDGE%" (
  echo Microsoft Edge was not found. Install Edge from Microsoft before using this entry.
  exit /b 1
)
if not defined LOCALAPPDATA (
  echo LOCALAPPDATA is unavailable. No browser was started.
  exit /b 1
)
set "MEETING_PROFILE=%LOCALAPPDATA%\Babagan\MeetingEdge"
set "MEETING_DISABLED_FEATURES=MediaFoundationUseSWBRCForH264Camera,MediaFoundationUseSWBRCForH264Desktop"
if /i "%~1"=="--print-command" (
  echo Executable: "%MEETING_EDGE%"
  echo Profile: "%MEETING_PROFILE%"
  echo Disabled performance features: %MEETING_DISABLED_FEATURES%
  echo Enabled performance feature: WebRtcAV1HWEncode
  echo Background scheduling: active
  echo URL: https://meet.babagan.cloud
  exit /b 0
)
start "" "%MEETING_EDGE%" "--user-data-dir=%MEETING_PROFILE%" "--disable-features=%MEETING_DISABLED_FEATURES%" --enable-features=WebRtcAV1HWEncode --disable-background-timer-throttling --disable-renderer-backgrounding --no-first-run --new-window "https://meet.babagan.cloud"
exit /b %errorlevel%
