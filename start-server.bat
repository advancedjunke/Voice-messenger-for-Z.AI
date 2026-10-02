@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Voice Messenger — Сервер

cd /d "%~dp0"

echo ==========================================================
echo    🎙️  Voice Messenger — запуск сервера  (v1.0.14)
echo ==========================================================
echo.
echo  Этот компьютер станет ХОСТОМ чата. Все, кто откроет
echo  приложение в этой же сети, подключатся сюда АВТОМАТИЧЕСКИ.
echo.

REM ─── Определяем корень проекта (исходники или распакованное приложение) ───
set "ROOT=%~dp0"
if not exist "%ROOT%server\dist\index.js" (
  if exist "%ROOT%app\server\dist\index.js" (
    set "ROOT=%ROOT%app\"
  )
)

if not exist "%ROOT%server\dist\index.js" (
  if not exist "%ROOT%server\src\index.ts" (
    echo [ОШИБКА] Не найден сервер приложения ^(server\dist или server\src^).
    echo Запустите этот файл из папки проекта Voice Messenger.
    echo.
    pause
    exit /b 1
  )
)

REM ─── Шаг 1: проверяем Node.js ───
echo [1/4] Проверяю Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ❌ Node.js НЕ УСТАНОВЛЕН!
  echo.
  echo  1. Скачайте Node.js LTS с сайта:  https://nodejs.org/ru
  echo  2. Установите ^(всё по умолчанию, кнопка Next^)
  echo  3. Снова запустите этот файл
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo        Найден Node.js %%v ✓

REM ─── Шаг 2: зависимости сервера (только первый запуск) ───
echo [2/4] Проверяю зависимости...
if not exist "%ROOT%server\node_modules\" (
  echo        Первый запуск — устанавливаю зависимости сервера (1-2 минуты)...
  pushd "%ROOT%server"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  ❌ Не удалось установить зависимости. Проверьте интернет и запустите снова.
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo        Зависимости на месте ✓
)

REM ─── Шаг 3: сборка, если её нет ───
echo [3/4] Проверяю сборку...
if not exist "%ROOT%server\dist\index.js" (
  echo        Собираю сервер...
  pushd "%ROOT%server"
  call npm run build
  if errorlevel 1 (
    echo  ❌ Ошибка сборки сервера.
    popd
    pause
    exit /b 1
  )
  popd
)
if not exist "%ROOT%client\dist\index.html" (
  echo        Собираю клиент (для открытия в браузере по ссылке)...
  pushd "%ROOT%client"
  if not exist "node_modules\" call npm install --no-audit --no-fund
  call npm run build
  popd
) else (
  echo        Клиент собран ✓
)

REM ─── Шаг 4: брандмауэр Windows (чтобы друзья могли подключиться) ───
echo [4/4] Настраиваю брандмауэр Windows...
netsh advfirewall firewall show rule name="VoiceMessenger 3001 TCP" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="VoiceMessenger 3001 TCP" dir=in action=allow protocol=TCP localport=3001 >nul 2>nul
  netsh advfirewall firewall add rule name="VoiceMessenger 3001 UDP" dir=in action=allow protocol=UDP localport=3001 >nul 2>nul
  netsh advfirewall firewall add rule name="VoiceMessenger 3002 UDP" dir=in action=allow protocol=UDP localport=3002 >nul 2>nul
)
netsh advfirewall firewall show rule name="VoiceMessenger 3001 TCP" >nul 2>nul
if errorlevel 1 (
  echo        ⚠️ Не удалось добавить правила ^(нужны права администратора^).
  echo        Если друзья не смогут подключиться — кликните по этому файлу
  echo        ПРАВОЙ кнопкой → "Запуск от имени администратора" (один раз).
) else (
  echo        Порты 3001 (TCP/UDP) и 3002 (UDP) открыты ✓
)

echo.
echo ==========================================================
echo   Запускаю сервер... НЕ ЗАКРЫВАЙТЕ ЭТО ОКНО,
echo   пока люди общаются! (сверните его)
echo ==========================================================
echo.

REM Подсказка: ADDRESS уже в переменной среды PORT (по умолчанию 3001)
node "%ROOT%server\dist\index.js"

echo.
echo ==========================================================
echo   Сервер остановлен. Соединения разорваны.
echo ==========================================================
echo.
pause
