#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est introuvable. Installe Node.js 22.5 ou plus recent depuis https://nodejs.org puis relance ce script."
  exit 1
fi
exec node src/server.js --open
