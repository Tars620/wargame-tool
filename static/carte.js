import * as maplibre from './vendor/maplibre-gl.mjs';
import { layers, namedFlavor } from './vendor/protomaps-basemaps.mjs';
import { monter as monterPieces, collection as piecesGeojson, layerSpecs as piecesCouches, SOURCE_ID as PIECES_SOURCE } from './pieces.js';

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

const FONDS = {
  plan: { label: 'Plan', note: 'OpenStreetMap, lisible hors ligne' },
  relief: { label: 'Relief', note: 'Plan avec ombrage du terrain' },
  s2: { label: `Satellite haute résolution`, note: `Sentinel-2, mosaïque ${S2_YEAR} (usage non commercial)` },
  nasa: { label: 'Satellite quotidien', note: 'NASA VIIRS, 250 m, dernière journée disponible' },
};

const { Protocol } = window.pmtiles; // chargé par carte.html (version autonome : elle embarque fflate)
const $ = (id) => document.getElementById(id);
const state = { zones: [], zone: null, fond: 'plan', labels: true, relief3d: false, nasaDate: null, map: null };

// ---------- construction du style ----------
// Thème noir : la terre un peu plus claire que la mer pour que les côtes se lisent.
function flavorNoir() {
  const flavor = { ...namedFlavor('black') };
  const reglages = { background: '#050506', water: '#050506', earth: '#1a1b1f' };
  for (const [cle, valeur] of Object.entries(reglages)) if (cle in flavor) flavor[cle] = valeur;
  return flavor;
}

// Une seule langue : le nom français, sinon anglais, sinon le nom local (jamais plusieurs écritures empilées).
const NOM_FRANCAIS = ['coalesce', ['get', 'name:fr'], ['get', 'name:en'], ['get', 'name']];
function nomsFrancais(couches) {
  return couches.map((l) => (l.layout && l.layout['text-field'] && JSON.stringify(l.layout['text-field']).includes('"name')
    ? { ...l, layout: { ...l.layout, 'text-field': NOM_FRANCAIS } } : l));
}
const vecteur = (flavor) => nomsFrancais(layers('protomaps', flavor, { lang: 'fr' }));

const isOverlay = (layer) => ['boundaries', 'places'].includes(layer['source-layer']) || layer.id.includes('label');

// Frontières lisibles sur tout fond : couleur et épaisseur imposées (celles du thème étaient presque invisibles).
const COULEUR_FRONTIERE = { plan: '#a3a6b0', satellite: '#ffffff' };
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
  const couches = frontieres(vecteur(flavorNoir()), COULEUR_FRONTIERE.plan);
  return labels ? couches : couches.filter((l) => !isOverlay(l));
}

function hillshade() {
  return { id: 'hillshade', type: 'hillshade', source: 'dem', paint: {
    'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#000000',
    'hillshade-highlight-color': '#5a5d66', 'hillshade-accent-color': '#1d1e22' } };
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
  const overlay = labels ? textesLisibles(frontieres(vecteur(namedFlavor('black')).filter(isOverlay), COULEUR_FRONTIERE.satellite)) : [];
  return [dark, imagery, ...overlay];
}

function sourcesFor(fond, labels, zone) {
  const sources = {};
  const vector = { type: 'vector', url: `pmtiles://${location.origin}/maps/${zone.key}.pmtiles`, attribution: '© OpenStreetMap' };
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
  style.sources[PIECES_SOURCE] = { type: 'geojson', data: piecesGeojson() };
  style.layers = [...style.layers, ...piecesCouches()];
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

function createMap() {
  maplibre.addProtocol('pmtiles', new Protocol().tile);
  const zone = state.zone;
  const map = new maplibre.Map({ container: 'map', style: buildStyle(), center: zone.center, zoom: zone.zoom,
    maxZoom: zone.maxzoom + 2, maxBounds: boundsFor(zone), attributionControl: { compact: false }, hash: true });
  map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.on('mousemove', (e) => { $('lecture').textContent = `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}  ·  zoom ${map.getZoom().toFixed(1)}`; });
  map.on('error', (e) => showError(`Chargement impossible : ${(e.error && e.error.message) || 'source indisponible'}`));
  map.on('styledata', () => showError(''));
  map.once('load', () => monterPieces(map).catch((e) => showError(`Pièces indisponibles : ${e.message}`)));
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
  const style = buildStyle();
  if (!state.map) { state.map = createMap(); return; }
  state.map.setStyle(style, { diff: true });
  state.map.setMaxZoom(state.zone.maxzoom + 2);
  state.map.setMaxBounds(boundsFor(state.zone) || null);
}

function setPitch() { state.map && state.map.easeTo({ pitch: state.relief3d ? PITCH_3D : 0, duration: 600 }); }

function flyToZone() {
  state.map.jumpTo({ center: state.zone.center, zoom: state.zone.zoom, pitch: state.relief3d ? PITCH_3D : 0 });
}

// ---------- panneau ----------
function fillFonds() {
  const box = $('fonds');
  for (const [key, f] of Object.entries(FONDS)) {
    const label = document.createElement('label'); label.className = 'opt';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'fond', value: key, checked: key === state.fond });
    const text = document.createElement('span'); text.textContent = f.label;
    const small = document.createElement('small'); small.textContent = f.note; text.append(small);
    input.addEventListener('change', () => { state.fond = key; render(); });
    label.append(input, text); box.append(label);
  }
}

function fillZones() {
  const select = $('zone');
  for (const z of state.zones) select.append(Object.assign(document.createElement('option'), { value: z.key, textContent: `${z.label} · ${(z.bytes / 1e6).toFixed(0)} Mo` }));
  select.addEventListener('change', () => { state.zone = state.zones.find((z) => z.key === select.value); showZone(); render().then(flyToZone); });
}

function showZone() {
  $('zoneinfo').textContent = `Plan : OpenStreetMap au ${state.zone.osm}, jusqu'au zoom ${state.zone.maxzoom}. Satellite et relief : chargés depuis Internet.`;
}

async function start() {
  const res = await fetch('/api/maps');
  state.zones = await res.json();
  if (!state.zones.length) { showError('Aucune zone : placez un fichier .pmtiles dans data/maps et déclarez-le dans zones.json.'); return; }
  state.zone = state.zones[0];
  fillFonds(); fillZones(); showZone();
  $('labels').addEventListener('change', (e) => { state.labels = e.target.checked; render(); });
  $('relief3d').addEventListener('change', (e) => { state.relief3d = e.target.checked; render().then(setPitch); });
  await render();
}

start().catch((e) => showError(e.message));
