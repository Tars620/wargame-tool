# Journal de wargame + carte

Outil léger pour les wargames : **capture** des décisions, **traçabilité** (journal chaîné par hachage),
**logistique** (une commande, un lien). Les décisions restent humaines. Sans dépendance Python.

    ./lancer.sh                  # démarre le serveur et ouvre http://127.0.0.1:8080/carte (journal : /)
    python3 -m unittest discover -s tests && node --test tests/geo.test.mjs

## Carte (`/carte`)
Quatre fonds : Plan (OpenStreetMap, 2026-11-20), Relief (ombrage), Satellite Sentinel-2 (2025),
Satellite quotidien NASA (dernière journée disponible, trouvée automatiquement). Relief 3D en option.
Style : noir, angles droits, Inter. Noms de lieux en français seulement.

**Zones de jeu** = fichiers `.pmtiles` dans `data/maps/`, déclarés dans `zones.json`.
Ajouter une zone : `scripts/extraire_zone.sh baltique 9,53,30,61 12` (outil `tools/pmtiles`,
à télécharger : https://github.com/protomaps/go-pmtiles/releases, v1.31.2), puis l'ajouter à `zones.json`.

## Pièces (`/carte`, panneau de droite)
Banque de six pièces (UAV de reconnaissance, UAV armé, fantassin, véhicule blindé, artillerie, guerre électronique),
définies dans `static/pieces.json`. Choisir un camp et une pièce, puis cliquer sur la carte pour la poser.
Chaque pièce a trois propriétés, modifiables après la pose : **mouvement** (vitesse min/max en km/h),
**feu** (portée en km, puissance de 0 à 10), **vision** (rayon en km). Les portées sont tracées sur la carte
(vision en trait plein, feu en pointillés). Un déplacement (glisser la pièce) donne la distance et le temps
de trajet aux vitesses min et max. Les pièces sont gardées dans le navigateur (pas encore dans le journal de partie).
Les valeurs du catalogue sont des paramètres de jeu de départ, pas des données officielles.
La guerre électronique n'a pas encore d'effet de brouillage.

## Limites connues
- **Pas entièrement hors ligne** : le plan l'est (géométrie), mais le relief, les satellites et les polices des noms
  de lieux sont chargés depuis Internet.
- Sentinel-2 : licence CC BY-NC-SA (usage non commercial). OpenStreetMap : ODbL (mention obligatoire).
- Les frontières sont celles d'OpenStreetMap (état de fait), y compris les territoires contestés.
- Journal : un joueur peut déduire le nombre d'événements cachés de l'adversaire par les trous de numérotation.
- La chaîne de hachage détecte une modification, pas une réécriture complète par le propriétaire du serveur :
  noter l'empreinte hors de l'outil en fin de tour.
- Aucune authentification forte (jetons de session simples) ; réseau local de confiance uniquement.
