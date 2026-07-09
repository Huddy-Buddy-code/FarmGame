@echo off
REM ── Farm Logistics Sim — launch the dev server ──────────────────────────────
REM Double-click this file to start the game in your browser.

REM Run from this script's own folder, wherever it lives.
cd /d "%~dp0"

REM First run: install dependencies if node_modules is missing.
if not exist "node_modules" (
    echo Installing dependencies ^(first run only^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Is Node.js installed?  https://nodejs.org
        pause
        exit /b 1
    )
)

echo.
echo Starting dev server at http://localhost:5173
echo Opening your browser... close this window to stop the server.
echo.

REM Give Vite a moment to boot, then open the browser.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5173"

npm run dev

REM If the server exits (or fails to start), keep the window open to show why.
pause
