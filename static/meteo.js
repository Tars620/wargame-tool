import { maintenant, surTick } from './temps.js';

export const SOURCE_METEO = 'meteo';
export const SOURCE_RADAR = 'radar';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const VARIABLES = 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,cloud_cover,visibility';
const RADAR_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_MAXZOOM = 7;
const RADAR_RAFRAICHIR_MS = 5 * 60 * 1000;
const GRILLE = { colonnes: 7, lignes: 5 };
const ZOOM_MIN = 3;           // plus large, une grille de points n'a plus de sens
const DEBOUNCE_MS = 700;
const JOURS_PASSES = 92;      // fenêtre de données d'Open-Meteo (passé récent et quelques jours de prévision)
const JOURS_FUTUR = 15;
const JOUR_MS = 86400000;

const state = { actifs: { radar: false, vent: false, temperature: false }, map: null, surChangement: () => {}, radar: null,
  grille: { type: 'FeatureCollection', features: [] }, statut: '', cleHeure: '', requete: 0, cache: new Map(), minuteur: null };
const $ = (id) => document.getElementById(id);

// ---------- fenêtre de données et heure de jeu ----------
export function fenetre() {
  const jour = (d) => new Date(d).toISOString().slice(0, 10);
  const maintenantReel = Date.now();
  return { debut: jour(maintenantReel - JOURS_PASSES * JOUR_MS), fin: jour(maintenantReel + JOURS_FUTUR * JOUR_MS) };
}
const jourUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const heureUtc = (ms) => new Date(ms).getUTCHours();
const dansFenetre = (ms) => { const f = fenetre(); const j = jourUtc(ms); return j >= f.debut && j <= f.fin; };
const cleHeure = (ms) => `${jourUtc(ms)}T${String(heureUtc(ms)).padStart(2, '0')}`;
const arrondi = (x) => Math.round(x * 100) / 100;

// ---------- données ----------
async function chargerJour(points, ms) {
  const jour = jourUtc(ms);
  const manquants = points.filter(([lng, lat]) => !state.cache.has(`${jour}|${arrondi(lat)},${arrondi(lng)}`));
  if (manquants.length) {
    const url = `${OPEN_METEO}?latitude=${manquants.map((p) => p[1]).join(',')}&longitude=${manquants.map((p) => p[0]).join(',')}`
      + `&hourly=${VARIABLES}&timezone=UTC&wind_speed_unit=kmh&start_date=${jour}&end_date=${jour}`;
    const rep = await fetch(url);
    if (!rep.ok) throw new Error((await rep.json().catch(() => ({}))).reason || `Open-Meteo : erreur ${rep.status}`);
    const corps = await rep.json();
    (Array.isArray(corps) ? corps : [corps]).forEach((r, i) => state.cache.set(`${jour}|${arrondi(manquants[i][1])},${arrondi(manquants[i][0])}`, r.hourly));
  }
  return points.map(([lng, lat]) => state.cache.get(`${jour}|${arrondi(lat)},${arrondi(lng)}`));
}

function lire(h, ms) {
  const i = heureUtc(ms);
  return { temperature: h.temperature_2m[i], vent_kmh: h.wind_speed_10m[i], direction: h.wind_direction_10m[i], rafales: h.wind_gusts_10m[i],
    precipitation: h.precipitation[i], nuages: h.cloud_cover[i], visibilite_m: h.visibility[i] };
}

/** Conditions prévues en un point à l'heure `ms` : rend l'objet, ou null si l'heure est hors de la fenêtre de données. */
export async function conditions(lng, lat, ms = maintenant()) {
  if (!dansFenetre(ms)) return null;
  const [h] = await chargerJour([[lng, lat]], ms);
  return h ? lire(h, ms) : null;
}

function pointsDeGrille() {
  const b = state.map.getBounds();
  const w = Math.max(b.getWest(), -180), e = Math.min(b.getEast(), 180), s = Math.max(b.getSouth(), -85), n = Math.min(b.getNorth(), 85);
  const points = [];
  for (let i = 0; i < GRILLE.lignes; i += 1) for (let j = 0; j < GRILLE.colonnes; j += 1) {
    points.push([w + ((j + 0.5) / GRILLE.colonnes) * (e - w), s + ((i + 0.5) / GRILLE.lignes) * (n - s)]);
  }
  return points;
}

async function actualiser() {
  if (!state.map || !(state.actifs.vent || state.actifs.temperature)) { state.grille = { type: 'FeatureCollection', features: [] }; majSource(); return; }
  const ms = maintenant();
  if (state.map.getZoom() < ZOOM_MIN) return statut('Zoomez pour afficher la météo prévue.', true);
  if (!dansFenetre(ms)) { const f = fenetre(); return statut(`Pas de prévision à cette date : données du ${f.debut} au ${f.fin}.`, true); }
  const numero = ++state.requete;
  statut('Chargement de la météo…');
  try {
    const points = pointsDeGrille();
    const jours = await chargerJour(points, ms);
    if (numero !== state.requete) return; // une vue plus récente a pris le relais
    state.grille = { type: 'FeatureCollection', features: points.map(([lng, lat], i) => {
      const c = lire(jours[i], ms);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { kmh: c.vent_kmh, dir: c.direction, temp: c.temperature } };
    }) };
    state.cleHeure = cleHeure(ms);
    majSource(); statut('');
  } catch (e) { statut(`Météo indisponible : ${e.message}`, true); }
}

function planifier() { clearTimeout(state.minuteur); state.minuteur = setTimeout(() => { actualiser(); fiche(); }, DEBOUNCE_MS); }

// ---------- radar de pluie (temps réel) ----------
async function chargerRadar() {
  try {
    const corps = await (await fetch(RADAR_INDEX)).json();
    const dernier = corps.radar.past[corps.radar.past.length - 1];
    const url = `${corps.host}${dernier.path}/256/{z}/{x}/{y}/2/1_1.png`;
    if (!state.radar || state.radar.url !== url) { state.radar = { url, instant: dernier.time }; if (state.actifs.radar) state.surChangement(); }
  } catch { state.radar = null; }
}

// ---------- couches de la carte ----------
function flecheVent() {
  const t = 40, c = document.createElement('canvas');
  c.width = t; c.height = t;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(t / 2, 3); g.lineTo(t * 0.78, t * 0.62); g.lineTo(t / 2, t * 0.5); g.lineTo(t * 0.22, t * 0.62); g.closePath(); g.fill();
  g.fillRect(t / 2 - 2, t * 0.5, 4, t * 0.42);
  return g.getImageData(0, 0, t, t);
}
const ajouterImage = () => { if (state.map && !state.map.hasImage('fleche-vent')) state.map.addImage('fleche-vent', flecheVent(), { sdf: true }); };

const texte = { 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true };
const textePaint = { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.5 };

/** Sources et couches à ajouter au style selon les calques cochés. */
export function pourStyle() {
  const sources = { [SOURCE_METEO]: { type: 'geojson', data: state.grille } };
  const layers = [];
  if (state.actifs.radar && state.radar) {
    sources[SOURCE_RADAR] = { type: 'raster', tiles: [state.radar.url], tileSize: 256, maxzoom: RADAR_MAXZOOM, attribution: 'Radar : RainViewer' };
    layers.push({ id: 'meteo-radar', type: 'raster', source: SOURCE_RADAR, paint: { 'raster-opacity': 0.7 } });
  }
  if (state.actifs.vent) {
    layers.push({ id: 'meteo-vent', type: 'symbol', source: SOURCE_METEO,
      layout: { 'icon-image': 'fleche-vent', 'icon-rotate': ['+', ['get', 'dir'], 180], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
        'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['get', 'kmh'], 0, 0.5, 70, 1.2] },
      paint: { 'icon-color': ['step', ['get', 'kmh'], '#8fd3ff', 15, '#7be0a0', 30, '#ffd166', 45, '#ff7b54', 60, '#ff3b3b'], 'icon-halo-color': '#000000', 'icon-halo-width': 1.2 } });
    layers.push({ id: 'meteo-vitesse', type: 'symbol', source: SOURCE_METEO,
      layout: { ...texte, 'text-field': ['to-string', ['round', ['get', 'kmh']]], 'text-offset': [0, 1.7] }, paint: textePaint });
  }
  if (state.actifs.temperature) {
    layers.push({ id: 'meteo-temperature', type: 'symbol', source: SOURCE_METEO,
      layout: { ...texte, 'text-field': ['concat', ['to-string', ['round', ['get', 'temp']]], '°'], 'text-offset': [0, state.actifs.vent ? -1.7 : 0] }, paint: textePaint });
  }
  return { sources, layers };
}

function majSource() { const s = state.map && state.map.getSource(SOURCE_METEO); if (s) s.setData(state.grille); }

// ---------- panneau ----------
function statut(texteStatut, avertissement = false) { const e = $('meteo-statut'); if (e) { e.textContent = texteStatut; e.className = avertissement ? 'note' : 'note'; } }

const dir = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((deg % 360) / 45)) % 8];
async function fiche() {
  const boite = $('meteo-fiche');
  if (!boite || !state.map) return;
  const c = state.map.getCenter(), ms = maintenant();
  if (state.map.getZoom() < ZOOM_MIN) { boite.textContent = 'Zoomez sur une zone pour voir les conditions en son centre.'; return; }
  try {
    const m = await conditions(c.lng, c.lat, ms);
    if (!m) { const f = fenetre(); boite.textContent = `Pas de données à cette date (du ${f.debut} au ${f.fin}).`; return; }
    const km = m.visibilite_m == null ? '—' : m.visibilite_m >= 1000 ? `${(m.visibilite_m / 1000).toFixed(m.visibilite_m >= 10000 ? 0 : 1).replace('.', ',')} km` : `${Math.round(m.visibilite_m)} m`;
    boite.replaceChildren(...[`Température ${Math.round(m.temperature)} °C`, `Vent ${Math.round(m.vent_kmh)} km/h du ${dir(m.direction)}, rafales ${Math.round(m.rafales)} km/h`,
      `Précipitations ${m.precipitation.toString().replace('.', ',')} mm/h · nuages ${Math.round(m.nuages)} %`, `Visibilité ${km}`]
      .map((t) => Object.assign(document.createElement('p'), { className: 'ligne-meteo', textContent: t })));
  } catch (e) { boite.textContent = `Météo indisponible : ${e.message}`; }
}

function dessinerPanneau() {
  const defs = [['radar', 'Radar de pluie', 'Temps réel (RainViewer), indépendant de l\'heure de jeu'], ['vent', 'Vent prévu', "À l'heure de jeu (Open-Meteo), en km/h"], ['temperature', 'Température prévue', "À l'heure de jeu (Open-Meteo), en °C"]];
  const cases = defs.map(([cle, nom, note]) => {
    const label = document.createElement('label'); label.className = 'opt';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.actifs[cle] });
    input.addEventListener('change', () => { state.actifs = { ...state.actifs, [cle]: input.checked }; state.surChangement(); actualiser(); });
    const t = document.createElement('span'); t.textContent = nom;
    const p = document.createElement('small'); p.textContent = note; t.append(p);
    label.append(input, t); return label;
  });
  const statutEl = Object.assign(document.createElement('p'), { id: 'meteo-statut', className: 'note' });
  const titre = Object.assign(document.createElement('h4'), { textContent: 'Au centre de la carte' });
  const ficheEl = Object.assign(document.createElement('div'), { id: 'meteo-fiche', className: 'note' });
  $('meteo-panneau').replaceChildren(...cases, statutEl, titre, ficheEl);
}

export function monter(map, { surChangement }) {
  state.map = map; state.surChangement = surChangement;
  map.on('styleimagemissing', (e) => { if (e.id === 'fleche-vent') ajouterImage(); });
  ajouterImage();
  map.on('moveend', planifier);
  surTick((ms) => { if (state.cleHeure && cleHeure(ms) !== state.cleHeure) planifier(); }); // l'heure de jeu a changé d'heure
  dessinerPanneau(); chargerRadar(); setInterval(chargerRadar, RADAR_RAFRAICHIR_MS); planifier();
}
