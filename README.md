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

## Carte : affichage, zones et dessin
Mise en page de logiciel : en-tête et barre d'outils collées en haut, panneaux collés aux bords gauche et droit
sur toute la hauteur ; un onglet sur le bord de la carte replie un panneau en entier, et chaque section se plie.
La page se recharge seule quand le code du serveur change (`/api/version`), en gardant pièces, dessins et consignes.
- **Affichage** sombre ou clair (mémorisé). **Zones** : Monde (zoom 7 agrandi jusqu'à 9) lisible hors ligne ;
  **Planète (en ligne, zoom 15)** donne le détail partout en passant par le serveur, qui relaie la carte
  Protomaps du 2026-11-20 (tranches bornées à 8 Mo, adresse fixée dans `zones.json`). Une zone sans données
  plus fines est agrandie de 2 niveaux au plus, puis la page propose la zone la plus détaillée.
- **Dessin** (barre en haut de la carte) : ligne de front (trait épais avec chevrons dans le sens du tracé),
  limite (pointillés), zone (périmètre et surface), mesure (distance, non enregistrée). Camp bleu, rouge ou neutre.
  Double-clic ou Entrée termine, Retour arrière retire le dernier point, Échap annule. Dessin sélectionné :
  glisser les carrés pour déplacer un point, clic droit pour en retirer un. Enregistrés dans le navigateur.

## Temps, météo et consignes (`/carte`)
- **Temps de jeu** : une seule horloge, qui suit l'heure réelle au départ. Lecture, pause, vitesses ×1 à ×1800,
  réglage de l'heure (saisie en heure de Paris), retour à l'heure réelle. En haut : heure de Paris et heure locale
  du centre de la carte (fuseau trouvé par `tz-lookup`), affichée dès le zoom 3.
- **Météo** : radar de pluie en temps réel (RainViewer) ; vent et température prévus **à l'heure de jeu** sur une
  grille de 35 points (Open-Meteo, usage non commercial) ; fiche des conditions au centre. Données disponibles
  du 20/08 au 06/12/2026 (fenêtre glissante) : hors de cette plage, la page le dit.
- **Consignes** (panneau de droite) : par pièce, *aller à* (un point ou un itinéraire, allure prudente / normale /
  maximale = vitesse min / moyenne / max), *observer* (durée), *engager* (la pièce s'approche jusqu'à sa portée
  puis tire ; **le résultat du tir est laissé à l'arbitre**). Chaque consigne est vérifiée selon les capacités de la
  pièce (vitesse, feu, portée, limite de vent des UAV) et donne distance, durée et heure d'arrivée prévue (Paris).
  « Lancer l'opération » exécute les consignes avec l'horloge de jeu ; contacts (vision), départs, arrivées et tirs
  vont au journal des opérations. « Point de vue » : l'arbitre voit tout, un camp ne voit que ses pièces et ce que
  leur vision révèle. « Revenir au départ » rétablit les positions d'avant le lancement.
- Logique pure et testée : `static/moteur.js` (faisabilité, déplacement, contacts), `static/fuseaux.js` (heures).

## Symboles, scénarios et bibliothèques réutilisées
- **Symboles** : les pièces utilisent les symboles militaires APP-6D / MIL-STD-2525D dessinés par **milsymbol**
  (MIT). Bleu = ami, rouge = hostile. Chaque modèle de `static/pieces.json` porte son code (ensemble + entité) ;
  les six sont vérifiés valides pour les deux camps par `tests/symboles.test.mjs`. Les deux UAV partagent le même symbole.
- **Scénario** (panneau de gauche) : *Enregistrer* (pièces, dessins, consignes, journal, en `.json`), *Ouvrir*,
  *Exporter en GeoJSON* (pièces en points avec leur code APP-6D, dessins en lignes et polygones, lisible par d'autres outils
  de cartographie). À l'ouverture, le fichier est vérifié champ par champ (`static/scenario.js`) : au moindre défaut il est
  refusé en entier et le scénario en cours n'est pas touché. Limite : 5 Mo, 2000 pièces.
- Réutilisé : milsymbol (symboles), Turf (couloirs), MapLibre, PMTiles, tz-lookup. Étudié mais non repris :
  *orbat-mapper* (MIT) est une application Vue complète (hiérarchies d'unités, lecture temporelle, grille MGRS,
  import/export KML) qui demande une chaîne de build ; elle sert de référence de fonctionnalités. Le GeoJSON exporté
  n'a pas été essayé dans orbat-mapper. *terra-draw* (dessin) fait double emploi avec nos outils de dessin.

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
- Pièces, consignes et journal des opérations sont gardés dans le navigateur : ni partagés entre postes, ni encore
  reliés au journal de partie. Les tirs ne causent aucun dégât (arbitrage humain) ; la météo ne limite que le vent des UAV.
- **Pas entièrement hors ligne** : le plan l'est (géométrie), mais le relief, les satellites et les polices des noms
  de lieux sont chargés depuis Internet.
- Sentinel-2 : licence CC BY-NC-SA (usage non commercial). OpenStreetMap : ODbL (mention obligatoire).
- Les frontières sont celles d'OpenStreetMap (état de fait), y compris les territoires contestés.
- Journal : un joueur peut déduire le nombre d'événements cachés de l'adversaire par les trous de numérotation.
- La chaîne de hachage détecte une modification, pas une réécriture complète par le propriétaire du serveur :
  noter l'empreinte hors de l'outil en fin de tour.
- Aucune authentification forte (jetons de session simples) ; réseau local de confiance uniquement.
