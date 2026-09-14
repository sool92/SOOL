@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Local preview server for person-site
echo ============================================
echo.

set PORT=8000

where python >nul 2>nul
if not errorlevel 1 goto usepython

where node >nul 2>nul
if not errorlevel 1 goto usenode

echo [ERROR] Neither Python nor Node was found on this computer.
echo.
echo Falling back to opening index.html directly.
echo Music may NOT play this way. Install Python 3 first:
echo https://www.python.org/downloads/
echo.
pause
start "" "index.html"
goto :eof

:usepython
echo Server  : python -m http.server %PORT%
echo Address : http://localhost:%PORT%/
echo.
echo Close this window to stop the server.
echo.
start "" http://localhost:%PORT%/
python -m http.server %PORT%
goto :eof

:usenode
echo Server  : npx --yes serve -l %PORT%
echo Address : http://localhost:%PORT%/
echo.
echo Close this window to stop the server.
echo.
start "" http://localhost:%PORT%/
npx --yes serve -l %PORT% .
goto :eof
