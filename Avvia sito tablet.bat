@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Preventivatore tablet
echo.
echo Preventivatore tablet
echo.
set "PY="
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>&1 && set "PY=python"
if not defined PY python3 -c "import sys" >nul 2>&1 && set "PY=python3"
if not defined PY (
  echo Python non risulta installato.
  echo.
  echo 1. Apri https://www.python.org/downloads/
  echo 2. Installa e spunta Add python.exe to PATH
  echo 3. Fai di nuovo doppio clic su questo file.
  echo.
  pause
  exit /b 1
)
set SITE_TABLET=1
set SITE_DEV=
set SITE_OPEN=1
echo Il browser si apre da solo. Per spegnere il sito chiudi questa finestra.
echo.
echo Questa versione non salva nomi, email o telefoni.
echo.
%PY% site\server.py
echo.
echo Il sito si e' chiuso.
pause
