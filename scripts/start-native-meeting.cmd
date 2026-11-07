@echo off
setlocal
set "nativeMeetingPwsh="
for %%P in (pwsh.exe) do set "nativeMeetingPwsh=%%~$PATH:P"
if not defined nativeMeetingPwsh if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" (
  set "nativeMeetingPwsh=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
)
if not defined nativeMeetingPwsh (
  echo PowerShell 7 is required. Install it, then run this launcher again.
  pause
  exit /b 1
)
"%nativeMeetingPwsh%" -NoLogo -NoProfile -File "%~dp0start-native-meeting.ps1" %*
set "nativeMeetingExit=%ERRORLEVEL%"
if not "%nativeMeetingExit%"=="0" (
  echo Native meeting startup failed. See the diagnostic above.
  pause
)
exit /b %nativeMeetingExit%
