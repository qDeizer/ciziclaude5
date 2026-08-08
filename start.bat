@echo off
setlocal

cd /d "%~dp0"

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo Electron bulunamadi: "%ELECTRON_EXE%"
  echo Proje bagimliliklarini yuklemek icin npm install calistirin.
  pause
  exit /b 1
)

echo Cizi Code baslatiliyor...
"%ELECTRON_EXE%" "%~dp0."
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Uygulama baslatilamadi. Cikis kodu: %EXIT_CODE%
  pause
)

endlocal & exit /b %EXIT_CODE%
