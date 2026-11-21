import * as maplibre from './vendor/maplibre-gl.mjs';
import { layers, namedFlavor } from './vendor/protomaps-basemaps.mjs';
import { monter as monterPieces, collection as piecesGeojson, layerSpecs as piecesCouches, SOURCE_ID as PIECES_SOURCE, piecesRetirees } from './pieces.js';
import { assembler, valider, versGeoJSON, TAILLE_MAX_OCTETS, CLES_STOCK } from './scenario.js';
import { preparerRole, remplirPanneau, demarrerSynchronisation } from './partie-ui.js';
import { monter as monterTemps } from './temps.js';
import { monter as monterIa } from './ia.js';
import { monter as monterMeteo, pourStyle as meteoPourStyle } from './meteo.js';
import { monter as monterOrdres, noterOperation, collection as consignesGeojson, layerSpecs as consignesCouches, setTheme as themeOrdres, SOURCE_CONSIGNES } from './ordres.js';
import { monter as monterDessin, collection as dessinsGeojson, collectionBrouillon, layerSpecs as dessinsCouches,
  setTheme as themeDessin, majTheme as majThemeDessin, SOURCE_DESSINS, SOURCE_BROUILLON } from './dessin.js';

// Polices des noms de lieux : encore chargées depuis Internet (voir la note de la page).
const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const DEM_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const S2_YEAR = 2025;
const S2_TILES = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${S2_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`;
const NASA_LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
const nasaTiles = (date) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${NASA_LAYER}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
const NASA_PROBE = '6/25/31'; // une tuile quelconque, servie dès qu'une journée d'imagerie existe
const NASA_MAX_DAYS = 45;
const PITCH_3D = 60;
const TERRAIN_EXAGGERATION = 1.4;
const SURZOOM = 2;        // niveaux d'agrandissement au-delà des données d'une zone locale
const SURZOOM_DETAIL = 5; // une zone détaillée (zoom 14 ou plus) peut aller bien plus loin : le vecteur reste net
const ZOOM_ABSOLU = 20;
const THEME_KEY = 'wg.theme';

const FONDS = {
  plan: { label: 'Plan', court: 'Plan', note: 'Plan : OpenStreetMap.' },
  relief: { label: 'Relief', court: 'Relief', note: 'Plan avec ombrage du terrain.' },
  s2: { label: 'Satellite haute résolution', court: 'Satellite HD', note: `Sentinel-2, mosaïque ${S2_YEAR} (usage non commercial).` },
  nasa: { label: 'Satellite quotidien', court: 'Satellite jour', note: 'NASA VIIRS, 250 m, dernière journée disponible.' },
};

// Thèmes : seul le plan et le relief changent de couleur ; les satellites restent des photos.
const THEMES = {
  sombre: { nom: 'Sombre', base: 'black', reglages: { background: '#050506', water: '#050506', earth: '#1a1b1f' }, frontPlan: '#a3a6b0',
    relief: { shadow: '#000000', highlight: '#5a5d66', accent: '#1d1e22' } },
  clair: { nom: 'Clair', base: 'light', reglages: { background: '#eceef2', water: '#c8d4e2', earth: '#f7f7f5' }, frontPlan: '#5f6168',
    relief: { shadow: '#3a3c42', highlight: '#ffffff', accent: '#a0a3ab' } },
};

const { Protocol } = window.pmtiles; // chargé par carte.html (version autonome : elle embarque fflate)
const $ = (id) => document.getElementById(id);
const state = { zones: [], zone: null, fond: 'plan', labels: true, relief3d: false, nasaDate: null, map: null, theme: lireTheme() };

function lireTheme() { try { const t = localStorage.getItem(THEME_KEY); return THEMES[t] ? t : 'sombre'; } catch { return 'sombre'; } }
function appliquerTheme() { document.documentElement.dataset.theme = state.theme; themeDessin(state.theme); themeOrdres(state.theme); }

// ---------- construction du style ----------
function flavor() {
  const t = THEMES[state.theme];
  const f = { ...namedFlavor(t.base) };
  for (const [cle, valeur] of Object.entries(t.reglages)) if (cle in f) f[cle] = valeur;
  return f;
}

// Une seule langue : le nom français, sinon anglais, sinon le nom local (jamais plusieurs écritures empilées).
const NOM_FRANCAIS = ['coalesce', ['get', 'name:fr'], ['get', 'name:en'], ['get', 'name']];
function nomsFrancais(couches) {
  return couches.map((l) => (l.layout && l.layout['text-field'] && JSON.stringify(l.layout['text-field']).includes('"name')
    ? { ...l, layout: { ...l.layout, 'text-field': NOM_FRANCAIS } } : l));
}
const vecteur = (f) => nomsFrancais(layers('protomaps', f, { lang: 'fr' }));

const isOverlay = (layer) => ['boundaries', 'places'].includes(layer['source-layer']) || layer.id.includes('label');

// Frontières lisibles sur tout fond : couleur et épaisseur imposées (celles du thème étaient presque invisibles).
function frontieres(couches, couleur) {
  return couches.map((l) => {
    if (l['source-layer'] !== 'boundaries' || l.type !== 'line') return l;
    const pays = l.id === 'boundaries_country';
    const largeur = pays ? ['interpolate', ['linear'], ['zoom'], 1, 0.9, 5, 1.5, 9, 2.2] : ['interpolate', ['linear'], ['zoom'], 3, 0.5, 9, 1.2];
    return { ...l, paint: { ...l.paint, 'line-color': couleur, 'line-width': largeur, 'line-opacity': pays ? 0.95 : 0.55 } };
  });
}

// Noms blancs cerclés de noir : lisibles sur une photo.
function textesLisibles(couches) {
  return couches.map((l) => (l.type === 'symbol'
    ? { ...l, paint: { ...l.paint, 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.6 } } : l));
}

// Le plan avec (ou sans) ses frontières et ses noms : la case s'applique à tous les fonds.
function plan(labels) {
  const couches = frontieres(vecteur(flavor()), THEMES[state.theme].frontPlan);
  return labels ? couches : couches.filter((l) => !isOverlay(l));
}

function hillshade() {
  const r = THEMES[state.theme].relief;
  return { id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
    'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': r.shadow, 'hillshade-highlight-color': r.highlight, 'hillshade-accent-color': r.accent } };
}

function layersFor(fond, labels) {
  if (fond === 'plan') return plan(labels);
  if (fond === 'relief') {
    const vec = plan(labels);
    const at = Math.max(vec.findIndex((l) => l.id === 'water'), 0);
    return [...vec.slice(0, at), hillshade(), ...vec.slice(at)];
  }
  const imagery = { id: 'imagerie', type: 'raster', source: 'imagerie' };
  const dark = { id: 'fond', type: 'background', paint: { 'background-color': '#0a0a0c' } };
  const overlay = labels ? textesLisibles(frontieres(vecteur(namedFlavor('black')).filter(isOverlay), '#ffffff')) : [];
  return [dark, imagery, ...overlay];
}

const urlZone = (zone) => (zone.en_ligne ? `pmtiles://${location.origin}/enligne/${zone.key}` : `pmtiles://${location.origin}/maps/${zone.key}.pmtiles`);

function sourcesFor(fond, labels, zone) {
  const sources = {};
  const vector = { type: 'vector', url: urlZone(zone), attribution: '© OpenStreetMap' };
  if (fond === 'plan' || fond === 'relief' || labels) sources.protomaps = vector;
  if (fond === 'relief' || state.relief3d) {
    sources.dem = { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
      attribution: 'Relief : Mapzen / AWS Terrain Tiles' };
  }
  if (fond === 's2') sources.imagerie = { type: 'raster', tiles: [S2_TILES], tileSize: 256, maxzoom: 14,
    attribution: `Sentinel-2 cloudless © EOX IT Services GmbH (contient des données Copernicus Sentinel ${S2_YEAR}), CC BY-NC-SA 4.0` };
  if (fond === 'nasa' && state.nasaDate) sources.imagerie = { type: 'raster', tiles: [nasaTiles(state.nasaDate)], tileSize: 256,
    maxzoom: 9, attribution: `NASA GIBS, VIIRS du ${state.nasaDate}` };
  return sources;
}

function buildStyle() {
  const { fond, labels, zone } = state;
  const style = { version: 8, glyphs: GLYPHS, sources: sourcesFor(fond, labels, zone), layers: layersFor(fond, labels) };
  if (fond === 'nasa' && !state.nasaDate) style.layers = [{ id: 'fond', type: 'background', paint: { 'background-color': '#0a0a0c' } }];
  const meteo = meteoPourStyle();
  Object.assign(style.sources, meteo.sources);
  style.sources[SOURCE_CONSIGNES] = { type: 'geojson', data: consignesGeojson() };
  style.sources[SOURCE_DESSINS] = { type: 'geojson', data: dessinsGeojson() };
  style.sources[SOURCE_BROUILLON] = { type: 'geojson', data: collectionBrouillon() };
  style.sources[PIECES_SOURCE] = { type: 'geojson', data: piecesGeojson() };
  style.layers = [...style.layers, ...meteo.layers, ...dessinsCouches(), ...consignesCouches(), ...piecesCouches()];
  if (state.relief3d) style.terrain = { source: 'dem', exaggeration: TERRAIN_EXAGGERATION };
  return style;
}

// ---------- imagerie NASA : dernière journée réellement servie ----------
async function latestNasaDate() {
  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const dates = Array.from({ length: NASA_MAX_DAYS }, (_, i) => day(i));
  const found = await Promise.all(dates.map(async (d) => {
    try { return (await fetch(nasaTiles(d).replace('{z}/{y}/{x}', NASA_PROBE))).ok ? d : null; } catch { return null; }
  }));
  return found.find(Boolean) || null; // dates triées de la plus récente à la plus ancienne
}

// ---------- carte ----------
function showError(message) { $('err').textContent = message || ''; }
const zoomMax = (zone) => Math.min(zone.maxzoom + (zone.maxzoom >= 14 ? SURZOOM_DETAIL : SURZOOM), ZOOM_ABSOLU);

function createMap() {
  maplibre.addProtocol('pmtiles', new Protocol().tile);
  const zone = state.zone;
  const map = new maplibre.Map({ container: 'map', style: buildStyle(), center: zone.center, zoom: zone.zoom,
    maxZoom: zoomMax(zone), maxBounds: boundsFor(zone), attributionControl: { compact: false }, hash: true });
  map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.on('mousemove', (e) => { $('lecture').textContent = `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}  ·  zoom ${map.getZoom().toFixed(1)}`; });
  map.on('error', (e) => showError(`Chargement impossible : ${(e.error && e.error.message) || 'source indisponible'}`));
  map.on('styledata', () => showError(''));
  map.on('zoomend', majInfoZone);
  new ResizeObserver(() => map.resize()).observe($('map'));
  // Les panneaux se montent dès que le style est prêt : inutile d'attendre les tuiles (lentes quand la carte est en ligne).
  map.once('style.load', () => {
    monterTemps(map);
    monterMeteo(map, { surChangement: () => render() });
    monterDessin(map);
    monterPieces(map).then(() => {
      monterOrdres(map); monterIa(map);
      remplirPanneau(); demarrerSynchronisation();
      const retirees = piecesRetirees();
      if (retirees.length) noterOperation(`Nouveau catalogue : ${retirees.length} pièce${retirees.length > 1 ? 's' : ''} sans équivalent retirée${retirees.length > 1 ? 's' : ''} (${retirees.join(', ')}).`);
    }).catch((e) => showError(`Pièces ou consignes indisponibles : ${e.message}`));
  });
  return map;
}

function boundsFor(zone) {
  if (!zone.bounds) return undefined;
  const [w, s, e, n] = zone.bounds, pad = 2;
  return [[w - pad, s - pad], [e + pad, n + pad]];
}

async function render() {
  if (state.fond === 'nasa' && !state.nasaDate) {
    $('err').textContent = 'Recherche de la dernière image NASA…';
    state.nasaDate = await latestNasaDate();
    if (!state.nasaDate) showError("Aucune image NASA trouvée sur les 45 derniers jours.");
  }
  appliquerTheme();
  const style = buildStyle();
  if (!state.map) { state.map = createMap(); return; }
  state.map.setStyle(style, { diff: true });
  state.map.setMaxZoom(zoomMax(state.zone));
  state.map.setMaxBounds(boundsFor(state.zone) || null);
}

function setPitch() { state.map && state.map.easeTo({ pitch: state.relief3d ? PITCH_3D : 0, duration: 600 }); }

function flyToZone() {
  state.map.jumpTo({ center: state.zone.center, zoom: state.zone.zoom, pitch: state.relief3d ? PITCH_3D : 0 });
}

// ---------- panneau ----------
function fillTheme() {
  const box = $('theme');
  box.replaceChildren(...Object.entries(THEMES).map(([cle, t]) => {
    const b = document.createElement('button');
    Object.assign(b, { type: 'button', textContent: t.nom });
    b.setAttribute('aria-pressed', String(state.theme === cle));
    b.addEventListener('click', () => {
      state.theme = cle;
      try { localStorage.setItem(THEME_KEY, cle); } catch { /* stockage indisponible */ }
      fillTheme(); render().then(majThemeDessin);
    });
    return b;
  }));
}

function fillFonds() {
  const box = $('fonds');
  const note = $('fond-note');
  const noter = () => { note.textContent = FONDS[state.fond].note; };
  for (const [key, f] of Object.entries(FONDS)) {
    const label = document.createElement('label'); label.className = 'opt';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'fond', value: key, checked: key === state.fond });
    const text = document.createElement('span'); text.textContent = f.court;
    input.addEventListener('change', () => { state.fond = key; noter(); render(); });
    label.append(input, text); box.append(label);
  }
  noter(); // la note du fond choisi (par exemple l'usage non commercial de Sentinel-2) reste visible sur une ligne
}

function fillZones() {
  const select = $('zone');
  select.value = '';
  for (const z of state.zones) {
    const taille = z.en_ligne ? 'en ligne' : `${(z.bytes / 1e6).toFixed(0)} Mo`;
    select.append(Object.assign(document.createElement('option'), { value: z.key, textContent: `${z.label} · ${taille}` }));
  }
  select.value = state.zone.key;
  select.addEventListener('change', () => { state.zone = state.zones.find((z) => z.key === select.value); majInfoZone(); render().then(flyToZone); });
}

function infoZone() {
  const z = state.zone;
  const origine = z.en_ligne ? 'chargé depuis Internet' : 'lisible hors ligne';
  return `Plan : OpenStreetMap au ${z.osm}, ${origine}, détaillé jusqu'au zoom ${z.maxzoom}. Satellites et relief : chargés depuis Internet.`;
}

function majInfoZone() {
  const plusFin = [...state.zones].sort((a, b) => b.maxzoom - a.maxzoom)[0];
  const limite = state.map && state.map.getZoom() >= zoomMax(state.zone) - 0.05;
  $('zoneinfo').textContent = limite && plusFin.maxzoom > state.zone.maxzoom
    ? `Zoom maximal de cette zone atteint. Pour zoomer plus loin, choisissez « ${plusFin.label} ».` : infoZone();
}

// ---------- scénario : enregistrer, ouvrir, exporter ----------
const lireStock = (cle, repli) => { try { return JSON.parse(localStorage.getItem(cle)) ?? repli; } catch { return repli; } };
const stockActuel = () => ({ pieces: lireStock(CLES_STOCK.pieces, []), dessins: lireStock(CLES_STOCK.dessins, []), ordres: lireStock(CLES_STOCK.ordres, {}), journal: lireStock(CLES_STOCK.journal, []) });
const horodatage = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

function telecharger(nom, contenu, type) {
  const lien = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([contenu], { type })), download: nom });
  document.body.append(lien); lien.click(); lien.remove();
  setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
}

function fillScenario() {
  const message = Object.assign(document.createElement('p'), { className: 'note' });
  const dire = (texte, erreur = false) => { message.textContent = texte; message.className = erreur ? 'err' : 'note'; };
  const bouton = (texte, onclick) => { const b = document.createElement('button'); Object.assign(b, { type: 'button', textContent: texte }); b.addEventListener('click', onclick); return b; };
  const courant = () => { const v = valider(assembler(stockActuel())); if (!v.ok) dire(`Le scénario actuel contient une valeur invalide : ${v.erreur}`, true); return v.ok ? v.scenario : null; };

  const fichier = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  fichier.addEventListener('change', async () => {
    const f = fichier.files[0]; fichier.value = '';
    if (!f) return;
    if (f.size > TAILLE_MAX_OCTETS) { dire('Fichier trop volumineux (5 Mo au plus).', true); return; }
    let objet;
    try { objet = JSON.parse(await f.text()); } catch { dire("Ce fichier n'est pas du JSON valide.", true); return; }
    const v = valider(objet);
    if (!v.ok) { dire(`Scénario refusé : ${v.erreur}`, true); return; }
    const sc = v.scenario;
    if (!confirm(`Ouvrir ce scénario ? Il remplace le scénario actuel (${sc.pieces.length} pièce(s), ${sc.dessins.length} dessin(s)).`)) return;
    try {
      localStorage.setItem(CLES_STOCK.pieces, JSON.stringify(sc.pieces)); localStorage.setItem(CLES_STOCK.dessins, JSON.stringify(sc.dessins));
      localStorage.setItem(CLES_STOCK.ordres, JSON.stringify(sc.ordres)); localStorage.setItem(CLES_STOCK.journal, JSON.stringify(sc.journal));
    } catch { dire('Impossible d\'enregistrer le scénario dans le navigateur (stockage plein ou bloqué).', true); return; }
    location.reload();
  });

  $('scenario-panneau').replaceChildren(
    bouton('Enregistrer (.json)', () => { const sc = courant(); if (sc) { telecharger(`scenario-${horodatage()}.json`, JSON.stringify(sc, null, 1), 'application/json'); dire('Scénario enregistré.'); } }),
    bouton('Ouvrir un scénario…', () => fichier.click()),
    bouton('Exporter en GeoJSON', async () => {
      const sc = courant(); if (!sc) return;
      try { const { pieces } = await (await fetch('/static/pieces.json')).json(); telecharger(`scenario-${horodatage()}.geojson`, JSON.stringify(versGeoJSON(sc, pieces), null, 1), 'application/geo+json'); dire('Export GeoJSON prêt.'); }
      catch (e) { dire(`Export impossible : ${e.message}`, true); }
    }),
    fichier, message,
    Object.assign(document.createElement('p'), { className: 'note', textContent: 'Le scénario contient les pièces, dessins, consignes et le journal. Le GeoJSON se lit dans les autres outils de cartographie (les pièces portent leur code APP-6D).' }));
}

// Chaque section des panneaux se plie et se déplie ; l'état est mémorisé.
const SECTIONS_KEY = 'wg.sections';
// Volets du panneau de droite : l'assistant d'abord ; sélectionner une pièce ou un dessin ouvre son volet.
const ONGLET_KEY = 'wg.onglet';
const ONGLETS = ['ia', 'pieces', 'consignes', 'dessins', 'journal'];
function voletsDroite() {
  let courant = 'ia';
  try { const v = localStorage.getItem(ONGLET_KEY); if (ONGLETS.includes(v)) courant = v; } catch { /* valeur par défaut */ }
  const montrer = (nom) => {
    courant = nom;
    try { localStorage.setItem(ONGLET_KEY, nom); } catch { /* stockage indisponible */ }
    for (const b of document.querySelectorAll('#onglets-d [data-onglet]')) b.setAttribute('aria-selected', String(b.dataset.onglet === nom));
    for (const v of document.querySelectorAll('[data-volet]')) v.hidden = v.dataset.volet !== nom;
  };
  for (const b of document.querySelectorAll('#onglets-d [data-onglet]')) b.addEventListener('click', () => montrer(b.dataset.onglet));
  document.addEventListener('wg:selection', (e) => {
    const cible = e.detail === 'dessin' ? 'dessins' : 'pieces';
    if (courant !== cible && !(cible === 'pieces' && courant === 'consignes')) montrer(cible);
  });
  montrer(courant);
}

function sectionsRepliables() {
  let etat = {};
  try { etat = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}'); } catch { etat = {}; }
  for (const d of document.querySelectorAll('details[data-cle]')) {
    if (d.dataset.cle in etat) d.open = etat[d.dataset.cle];
    d.addEventListener('toggle', () => { etat = { ...etat, [d.dataset.cle]: d.open }; try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(etat)); } catch { /* stockage indisponible */ } });
  }
}

// Les barres latérales sont collées aux bords de l'écran et se replient en entier (un onglet reste visible).
const PANNEAUX_KEY = 'wg.panneaux';
function panneauxRepliables() {
  let ouvert = { g: true, d: true };
  try { ouvert = { ...ouvert, ...JSON.parse(localStorage.getItem(PANNEAUX_KEY) || '{}') }; } catch { /* valeurs par défaut */ }
  const appliquer = () => {
    document.body.classList.toggle('g-ferme', !ouvert.g);
    document.body.classList.toggle('d-ferme', !ouvert.d);
    $('onglet-g').textContent = ouvert.g ? '‹' : '›';
    $('onglet-d').textContent = ouvert.d ? '›' : '‹';
    if (state.map) state.map.resize();
  };
  for (const cote of ['g', 'd']) {
    $(`onglet-${cote}`).addEventListener('click', () => {
      ouvert = { ...ouvert, [cote]: !ouvert[cote] };
      try { localStorage.setItem(PANNEAUX_KEY, JSON.stringify(ouvert)); } catch { /* stockage indisponible */ }
      appliquer();
    });
  }
  appliquer();
}

// Recharge la page quand le code a changé sur le serveur (un onglet resté ouvert garderait l'ancienne version).
const VERSION_PAS_MS = 4000;
function surveillerVersion() {
  let courante = null;
  const occupe = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName) || document.body.dataset.pointage === 'oui';
  setInterval(async () => {
    try {
      const { version } = await (await fetch('/api/version')).json();
      if (courante === null) courante = version;
      else if (version !== courante && !occupe()) location.reload();
    } catch { /* serveur momentanément injoignable : on réessaiera */ }
  }, VERSION_PAS_MS);
}

async function start() {
  sectionsRepliables();
  voletsDroite();
  panneauxRepliables();
  surveillerVersion();
  await preparerRole(); // le rôle (local, arbitre, joueur) conditionne tout ce qui est monté ensuite
  const res = await fetch('/api/maps');
  state.zones = await res.json();
  if (!state.zones.length) { showError('Aucune zone : placez un fichier .pmtiles dans data/maps et déclarez-le dans zones.json.'); return; }
  state.zone = [...state.zones].sort((x, y) => y.maxzoom - x.maxzoom)[0]; // la plus détaillée : on peut zoomer à fond
  appliquerTheme();
  fillTheme(); fillFonds(); fillZones(); fillScenario(); majInfoZone();
  $('labels').addEventListener('change', (e) => { state.labels = e.target.checked; render(); });
  // L'adresse garde l'inclinaison de la vue (#zoom/lat/lng/cap/inclinaison) : un lien ou un rechargement inclinés rouvrent donc avec le relief.
  const inclinaison = Number(location.hash.replace('#', '').split('/')[4]);
  if (inclinaison > 0) { state.relief3d = true; $('relief3d').checked = true; }
  $('relief3d').addEventListener('change', (e) => { state.relief3d = e.target.checked; render().then(setPitch); });
  await render();
  window.__carteOk = true; // lu par le filet de sécurité de carte.html
}

start().catch((e) => showError(e.message));
