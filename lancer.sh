#!/bin/sh
# Démarre le serveur et ouvre la carte. Ctrl+C pour arrêter.
cd "$(dirname "$0")"
(sleep 1.5; open "http://127.0.0.1:8080/carte") &
exec python3 server.py --port 8080
