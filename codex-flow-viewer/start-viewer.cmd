@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.18 or newer is required.
  pause
  exit /b 1
)
if not exist node_modules\react\package.json (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
if not exist dist\index.html (
  call npm.cmd run build
  if errorlevel 1 goto failed
)
node scripts\launch.mjs %*
if errorlevel 1 goto failed
echo.
echo Open the viewer using the browser address above.
echo If it was already running, closing this window will not stop it.
pause
exit /b 0
:failed
echo Viewer could not start. Read the error above.
pause
exit /b 1
