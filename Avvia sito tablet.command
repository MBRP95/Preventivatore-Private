#!/bin/bash
cd "$(dirname "$0")"
export SITE_TABLET=1
export SITE_OPEN=1
unset SITE_DEV
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python non risulta installato. Scaricalo da https://www.python.org/downloads/"
  read -r -p "Premi Invio per chiudere."
  exit 1
fi
echo "Il browser si apre da solo. Per spegnere il sito chiudi questa finestra."
python3 site/server.py
