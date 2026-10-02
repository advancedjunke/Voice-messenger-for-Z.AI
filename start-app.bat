@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Voice Messenger — Приложение

cd /d "%~dp0"

echo ==========================================================
echo    Voice Messenger - запуск приложения  (v1.0.16)
echo ==========================================================
echo.
echo  Откроется окно мессенджера. Если сервер ещё не запущен
echo  ни у кого в сети — этот ПК автоматически станет ХОСТОМ.
echo.

REM ─── Шаг 1: проверяем Node.js ───
echo [1/4] Проверяю Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ОШИБКА] Node.js НЕ УСТАНОВЛЕН!
  echo.
  echo  1. Скачайте Node.js LTS с сайта:  https://nodejs.org/ru
  echo  2. Установите ^(всё по умолчанию, кнопка Next^)
  echo  3. Снова запустите этот файл
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo        Найден Node.js %%v [OK]

REM ─── Шаг 2: зависимости (Electron) — только первый запуск ───
echo [2/4] Проверяю зависимости (первый запуск — 3-5 минут)...
if not exist "node_modules\" (
  echo        Устанавливаю Electron и инструменты сборки...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [ОШИБКА] Не удалось установить зависимости. Проверьте интернет и запустите снова.
    pause
    exit /b 1
  )
) else (
  echo        Зависимости на месте [OK]
)

REM ─── Шаг 3: сборка, если её нет ───
echo [3/4] Проверяю сборку...
if not exist "server\dist\index.js" (
  echo        Собираю сервер...
  pushd "server"
  if not exist "node_modules\" call npm install --no-audit --no-fund
  call npm run build
  if errorlevel 1 (
    echo  [ОШИБКА] Сборка сервера не удалась.
    popd
    pause
    exit /b 1
  )
  popd
)
if not exist "client\dist\index.html" (
  echo        Собираю интерфейс мессенджера...
  pushd "client"
  if not exist "node_modules\" call npm install --no-audit --no-fund
  call npm run build
  if errorlevel 1 (
    echo  [ОШИБКА] Сборка интерфейса не удалась.
    popd
    pause
    exit /b 1
  )
  popd
)
echo        Сборка готова [OK]

REM ─── Шаг 4: брандмауэр (чтобы друзья подключались к твоему встроенному серверу) ───
echo [4/4] Настраиваю брандмауэр Windows...
netsh advfirewall firewall show rule name="VoiceMessenger 3001 TCP" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="VoiceMessenger 3001 TCP" dir=in action=allow protocol=TCP localport=3001 >nul 2>nul
  netsh advfirewall firewall add rule name="VoiceMessenger 3001 UDP" dir=in action=allow protocol=UDP localport=3001 >nul 2>nul
  netsh advfirewall firewall add rule name="VoiceMessenger 3002 UDP" dir=in action=allow protocol=UDP localport=3002 >nul 2>nul
)

echo.
echo  Запускаю Voice Messenger... (это окно закроется само)
echo.

if exist "node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%CD%"
  exit /b 0
)

REM ─── Запасной вариант: Electron не установился — открываем в браузере ───
echo  [!] Electron не найден — открываю мессенджер в браузере.
echo  Сервер будет работать в свёрнутом окне — НЕ ЗАКРЫВАЙТЕ его.
start "VoiceMessenger Server" /min node "server\dist\index.js"
timeout /t 3 /nobreak >nul
start http://localhost:3001
echo.
echo  Готово! Мессенджер открыт в браузере на http://localhost:3001
pause
