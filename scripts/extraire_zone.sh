#!/bin/sh
# Extrait une zone de jeu de la carte OSM Protomaps (hors ligne ensuite).
# Usage : scripts/extraire_zone.sh NOM LON_MIN,LAT_MIN,LON_MAX,LAT_MAX ZOOM_MAX [AAAAMMJJ]
# Exemple : scripts/extraire_zone.sh baltique 9,53,30,61 12
# Estimer la taille d'abord : ajouter --dry-run à la commande pmtiles ci-dessous.
# Puis déclarer la zone dans zones.json (libellé, bounds, centre, zoom).
set -e
cd "$(dirname "$0")/.."
BUILD="${4:-$(date -u +%Y%m%d)}"
./tools/pmtiles extract "https://build.protomaps.com/${BUILD}.pmtiles" "data/maps/$1-z$3.pmtiles" --bbox="$2" --maxzoom="$3"
