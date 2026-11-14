@echo off
rem Запуск web UI rat: сервер только на loopback + автоматическое открытие браузера.
rem База: %RAT_DB%, иначе %USERPROFILE%\.rat\issues.db (как у глобального шима rat),
rem иначе дефолтная <repo>\data\issues.db.
rem Любые аргументы пробрасываются в `rat serve`, например:
rem   serve.bat --port 4800
rem   serve.bat --db data\issues.db
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js не найден в PATH. Нужен Node 24 или новее.
  pause
  exit /b 1
)

if not defined RAT_DB if exist "%USERPROFILE%\.rat\issues.db" set "RAT_DB=%USERPROFILE%\.rat\issues.db"

if defined RAT_DB (
  echo База: %RAT_DB%
) else (
  echo База: %~dp0data\issues.db ^(по умолчанию^)
)
echo.

node --no-warnings "%~dp0bin\rat.mjs" serve --open %*
set "code=%errorlevel%"

if not "%code%"=="0" (
  echo.
  echo [!] rat serve завершился с кодом %code%.
  pause
)
exit /b %code%
