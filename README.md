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
Banque de neuf pièces (voir « Catalogue et règles » plus bas ; ancienne liste : poste de commandement, UAV de reconnaissance, UAV armé, fantassin, véhicule blindé, artillerie, brouilleur),
définies dans `static/pieces.json`. Choisir un camp et une pièce, puis cliquer sur la carte pour la poser.
Chaque pièce a trois propriétés, modifiables après la pose : **mouvement** (vitesse min/max en km/h),
**feu** (portée en km, puissance de 0 à 10), **vision** (rayon en km). Les portées sont tracées sur la carte
(vision en trait plein, feu en pointillés). Un déplacement (glisser la pièce) donne la distance et le temps
de trajet aux vitesses min et max. Les pièces sont gardées dans le navigateur (pas encore dans le journal de partie).
Les valeurs du catalogue sont des paramètres de jeu de départ, pas des données officielles.
Le brouilleur n'a pas encore d'effet de brouillage.

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


## Assistant (onglet « Assistant », à droite de la carte)

On décrit la situation en français ; l'assistant la traduit en actions que l'arbitre coche puis applique. Exemple :
« 5 drones armés bleus côte à côte autour de 48,50 N 37,50 E, face à l'est. En face, 5 blindés rouges autour de 48,50 N 37,80 E. Les drones attaquent les blindés et les détruisent. »

- **Ce qu'il sait faire** : poser des pièces (en groupe : ligne, colonne, paquet, écart et cap), donner des consignes (aller, observer, engager), tracer des fronts, limites et zones, centrer la vue, régler l'horloge de jeu.
- **Il propose, l'arbitre décide** : rien n'est appliqué sans clic sur « Appliquer » ; chaque action se coche ou se décoche. Tout est revérifié côté navigateur (coordonnées, modèles du catalogue, capacités de chaque pièce) ; une pièce sans arme ne peut pas engager, la proposition est refusée avec la raison.
- **Destruction** : elle découle des règles du catalogue (voir plus bas), l'assistant ne « détruit » rien lui-même.
- **Fonctionnement** : le serveur appelle le programme `claude` (déjà connecté sur la machine) sans outils ni réglages, un appel à la fois, 90 s maximum. Modèle : `WG_IA_MODELE` (défaut `sonnet`, `haiku` pour réduire le coût). La route `/api/ia` n'est servie qu'à cette machine, jamais au réseau local.
- **Limites** : les lieux nommés sont donnés de mémoire par le modèle (le dire dans la réponse) ; les coordonnées saisies sont reprises telles quelles. Les actions appliquées sont notées dans le journal des opérations de la carte, pas encore dans le journal chaîné de la partie.
- **Temps de jeu** : plus de bouton « Lancer l'opération ». Les consignes s'exécutent dès qu'elles sont données, au rythme de l'horloge ; le bouton en haut (×1, Pause) l'arrête ou la reprend.
- **Voix** : bouton « Micro » à droite de la saisie. On parle, le texte apparaît dans le terminal, puis la demande part à la fin de la phrase (case décochable, pour relire avant d'envoyer). Case « Lire les réponses à voix haute » pour entendre la réponse ; la lecture s'arrête dès qu'on envoie ou dicte autre chose. ⚠ Le son est traité par le fournisseur du navigateur (Apple pour Safari, Google pour Chrome), il quitte l'ordinateur et la dictée exige Internet. Sans cette API (Firefox), le bouton n'apparaît pas. L'application n'enregistre aucun son.
- **Relief en 3D** : l'inclinaison de la vue est dans l'adresse ; rouvrir un lien incliné coche donc « Relief en 3D ».

## Catalogue et règles des pièces

Valeurs documentées par l'utilisateur ; les valeurs **estimées** sont signalées dans l'avertissement de chaque pièce (« à documenter »).

| Pièce | Mouvement | Observation | Feu | Spécifique |
|---|---|---|---|---|
| Équipe de pilotes | 4 km/h (estimé) | 0,5 km (estimé) | aucun | commande plusieurs drones |
| Voiture, moto | 40-90, 50-100 km/h (estimé) | 1 km (estimé) | aucun | roule sur route et en plaine, jamais sur l'eau (règle de terrain à venir) |
| Drone d'observation (ISR) | 70 km/h max | 1 km² au sol | aucun | endurance 45 min, portée opérationnelle 20 km, rentre se poser |
| Drone d'attaque (OWA) | 120 km/h max | 2 km² au sol | explose : 25 m² détruits | endurance 60 min, portée 50 km, sens unique |
| Drone filoguidé | 120 km/h max | 2 km² | explose : 25 m² | endurance 30 min, portée 25 km, insensible au brouillage |
| Brouilleur | 2 km/h | 0,5 km (estimé) | aucun | zone de 4 km : les drones ennemis qui y entrent sont perdus |
| Fantassin | 4 km/h | 1 km | tir direct à 300 m, ne détruit que fantassins et brouilleurs | |
| Artillerie | 30-50 km/h | 1 km (estimé) | zone de 50 m, dispersion 30 m, portée 20 km (estimés) | route seule (à venir) |

- **Destruction par les règles** : le drone d'attaque se détruit sur sa cible et détruit ce qui est dans 25 m² autour (tir ami compris) ; l'artillerie tire une fois par ordre sur une zone, avec une dispersion déterministe (même partie, mêmes impacts) ; le fantassin détruit sa cible permise. L'arbitre garde la main : boutons « Détruire » et « Rétablir » dans la fiche de chaque pièce, et « Revenir au départ ».
- **Drones** : au sol auprès de leur équipe, ils décollent au premier ordre ; l'endurance se décompte en vol. Un drone d'observation rentre seul quand il ne lui reste que le temps du retour (marge 10 %) et se pose, endurance rechargée ; un drone d'attaque non employé à temps est perdu. Un drone au sol n'observe rien et suit son équipe quand elle bouge.
- **Équipe de pilotes** : tout drone est rattaché à une équipe de son camp et reste dans **sa propre** portée opérationnelle autour d'elle. Rattachement automatique à la pose (équipe la plus proche qui le couvre) ou choisi dans la fiche ; une équipe commande autant de drones qu'on veut ; une équipe détruite n'est pas remplacée d'office.
- **Ce que le moteur refuse** : consigne d'un drone sans équipe, hors de portée ou équipe détruite ; destination ou point de frappe au-delà de la portée ; mission plus longue que l'endurance restante (vol + retour détaillés) ; engagement d'une catégorie que la pièce ne peut pas détruire ; rentrer pour un drone à sens unique. Un trajet qui traverse la zone d'un brouilleur ennemi est signalé.
- **En cours d'exécution** : liaison coupée (équipe déplacée, détruite, drone déplacé à la main) = événement au journal, lien en ambre, le drone n'exécute plus rien tant qu'elle ne revient pas.
- **Sur la carte** : trait plein équipe-drone, anneau pointillé de portée autour de l'équipe, zone du brouilleur.
- **Anciennes données** : à l'ouverture, les pièces de l'ancien catalogue sont reconstruites sur le nouveau (UAV armé devient drone d'attaque, poste de commandement devient équipe de pilotes, guerre électronique devient brouilleur) ; le véhicule blindé n'a pas d'équivalent et est retiré, avec une ligne au journal.
- **À venir (phases suivantes)** : rôles arbitre / rouge / bleu avec vues filtrées côté serveur ; terrain (forêt, eau, routes) pour la visibilité et les déplacements ; itinéraire routier de l'artillerie.
- **Filet de sécurité** : si la carte n'a pas pu démarrer (fichiers de versions mélangées pendant une mise à jour), la page se recharge seule, jusqu'à trois fois, puis affiche la cause au lieu de rester vide.
