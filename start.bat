@echo off
title AI Usage Monitor
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installe Node.js 22.5 ou plus recent depuis https://nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)
node src/server.js --open
pause
