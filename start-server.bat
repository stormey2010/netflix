@echo off
title Netflix Connect Server
echo
echo Starting Netflix Connect Server on port 8767...
echo Dashboard: http://localhost:8767/dashboard
echo

cd /d "%~dp0server"
python -m uvicorn app:app --host 0.0.0.0 --port 8767

if errorlevel 1 (
    echo.
    echo Server stopped or encountered an error.
    echo If port 8767 is in use, close the other server first.
)

pause
