@echo off
setlocal
cd /d "%~dp0"

rem Double-clicking may not inherit the Python or Node paths from your terminal.
set "APP_PYTHON="
if exist ".venv\Scripts\python.exe" set "APP_PYTHON=%CD%\.venv\Scripts\python.exe"
if not defined APP_PYTHON if defined CONDA_PREFIX if exist "%CONDA_PREFIX%\python.exe" set "APP_PYTHON=%CONDA_PREFIX%\python.exe"
if not defined APP_PYTHON if exist "%USERPROFILE%\miniconda3\envs\AuraJournal\python.exe" set "APP_PYTHON=%USERPROFILE%\miniconda3\envs\AuraJournal\python.exe"
if not defined APP_PYTHON if exist "%USERPROFILE%\anaconda3\envs\AuraJournal\python.exe" set "APP_PYTHON=%USERPROFILE%\anaconda3\envs\AuraJournal\python.exe"
if not defined APP_PYTHON set "APP_PYTHON=python"

where npm.cmd >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"

if /i "%~1"=="backend" goto backend
if /i "%~1"=="frontend" goto frontend

"%APP_PYTHON%" -c "import fastapi, uvicorn, dotenv, sqlalchemy, psycopg" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python or backend dependencies were not found.
    echo Activate your AuraJournal environment, then run:
    echo python -m pip install -r src/backend/requirements.txt
    goto failed
)
call npm.cmd --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm was not found. Install Node.js LTS and reopen this launcher.
    goto failed
)

if /i "%~1"=="--check" (
    echo Python and npm are ready.
    echo Python: "%APP_PYTHON%"
    exit /b 0
)

if not exist "src\frontend\node_modules\.bin\vite.cmd" (
    echo Installing frontend dependencies...
    pushd "src\frontend"
    call npm.cmd install
    if errorlevel 1 (
        popd
        echo ERROR: Frontend dependency installation failed.
        goto failed
    )
    popd
)
if not exist ".env" copy /y ".env.example" ".env" >nul
if not exist "src\frontend\.env.local" copy /y "src\frontend\.env.example" "src\frontend\.env.local" >nul

rem Use the same local SQLite database as the manual development commands.
rem An explicitly set DATABASE_URL in the calling terminal takes precedence.
if not defined DATABASE_URL set "DATABASE_URL=sqlite:///./aurajournal.db"
start "AuraJournal Backend" "%ComSpec%" /k ""%~f0" backend"
start "AuraJournal Frontend" "%ComSpec%" /k ""%~f0" frontend"
echo.
echo AuraJournal is starting in two separate windows.
echo Open http://localhost:5173 once Vite is ready.
echo API: http://127.0.0.1:8000/docs
echo Stop each server with Ctrl+C in its window.
exit /b 0

:backend
"%APP_PYTHON%" -m uvicorn app.main:app --app-dir src/backend --reload --env-file .env
exit /b %errorlevel%

:frontend
cd /d "%~dp0src\frontend"
call npm.cmd run dev -- --port 5173 --strictPort
exit /b %errorlevel%

:failed
if /i not "%~1"=="--check" pause
exit /b 1
