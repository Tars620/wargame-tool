import * as maplibre from './vendor/maplibre-gl.mjs';
import { distanceKm, longueurKm, aireKm2, formatKm, formatSurface } from './geo.js';
import { couloir, COULOIR_DEFAUT_KM } from './couloir.js';

export const SOURCE_DESSINS = 'dessins';
export const SOURCE_BROUILLON = 'brouillon';
const STORAGE_KEY = 'wg.dessins.v1';
const STORAGE_COULOIRS = 'wg.couloirs';
const CACHE_COULOIRS_MAX = 200;
const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };
const NEUTRE = { sombre: '#c9ccd4', clair: '#3a3c42' };
const NOM_CAMP = { bleu: 'Bleu', rouge: 'Rouge', neutre: 'Neutre' };
const OUTILS = { selection: 'Sélection', front: 'Ligne de front', limite: 'Limite', zone: 'Zone', mesure: 'Mesure' };
const NOM_GENRE = { front: 'Ligne de front', limite: 'Limite', zone: 'Zone' };
const POINTS_MIN = { front: 2, limite: 2, zone: 3, mesure: 2 };
const SELECTABLES = ['zone-fond', 'zone-trait', 'limite-trait', 'front-trait'];
const MARGE_CLIC_PX = 7;

const state = { dessins: [], outil: 'selection', camp: 'bleu', brouillon: [], curseur: null, fige: false, selection: null,
  theme: 'sombre', map: null, poignees: [], couloirs: lireCouloirs(), cacheCouloirs: new Map() };

const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

function lireCouloirs() { try { return localStorage.getItem(STORAGE_COULOIRS) === 'oui'; } catch { return false; } }
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const dessin = (id) => state.dessins.find((d) => d.id === id) || null;
const sauver = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.dessins)); } catch { /* stockage indisponible */ } };
function charger() {
  try { const brut = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(brut) ? brut : []; } catch { return []; }
}
function maj(id, patch) { state.dessins = state.dessins.map((d) => (d.id === id ? { ...d, ...patch } : d)); sauver(); }

export function setTheme(theme) { state.theme = theme; }

// ---------- couches ----------
const couleurDe = () => ['match', ['get', 'camp'], 'rouge', COULEURS.rouge, 'bleu', COULEURS.bleu, NEUTRE[state.theme]];
const filtreGenre = (genre) => ['==', ['get', 'genre'], genre];

export function layerSpecs() {
  const accent = state.theme === 'sombre' ? '#ffffff' : '#000000';
  return [
    { id: 'couloir-fond', type: 'fill', source: SOURCE_DESSINS, filter: filtreGenre('couloir'), paint: { 'fill-color': couleurDe(), 'fill-opacity': 0.1 } },
    { id: 'couloir-trait', type: 'line', source: SOURCE_DESSINS, filter: filtreGenre('couloir'), paint: { 'line-color': couleurDe(), 'line-width': 1.2, 'line-dasharray': [5, 3], 'line-opacity': 0.8 } },
    { id: 'dessin-choisi', type: 'line', source: SOURCE_DESSINS, filter: ['==', ['get', 'choisi'], true],
      paint: { 'line-color': accent, 'line-width': 9, 'line-opacity': 0.22 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
    { id: 'zone-fond', type: 'fill', source: SOURCE_DESSINS, filter: filtreGenre('zone'), paint: { 'fill-color': couleurDe(), 'fill-opacity': 0.13 } },
    { id: 'zone-trait', type: 'line', source: SOURCE_DESSINS, filter: filtreGenre('zone'), paint: { 'line-color': couleurDe(), 'line-width': 2 } },
    { id: 'limite-trait', type: 'line', source: SOURCE_DESSINS, filter: filtreGenre('limite'), paint: { 'line-color': couleurDe(), 'line-width': 2.2, 'line-dasharray': [4, 3] } },
    { id: 'front-trait', type: 'line', source: SOURCE_DESSINS, filter: filtreGenre('front'), layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': couleurDe(), 'line-width': 4 } },
    { id: 'front-chevrons', type: 'symbol', source: SOURCE_DESSINS, filter: filtreGenre('front'),
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 40, 'text-field': '>', 'text-font': ['Noto Sans Medium'], 'text-size': 18,
        'text-keep-upright': false, 'text-allow-overlap': true, 'text-ignore-placement': true, 'text-rotation-alignment': 'map' },
      paint: { 'text-color': state.theme === 'sombre' ? '#000000' : '#ffffff' } },
    { id: 'brouillon-trait', type: 'line', source: SOURCE_BROUILLON, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': accent, 'line-width': 2, 'line-dasharray': [2, 2] } },
    { id: 'brouillon-sommets', type: 'circle', source: SOURCE_BROUILLON, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': accent, 'circle-stroke-color': state.theme === 'sombre' ? '#000' : '#fff', 'circle-stroke-width': 1 } },
  ];
}

const kmCouloir = (d) => (Number.isFinite(d.couloir_km) ? d.couloir_km : COULOIR_DEFAUT_KM);

/** Couloir d'un dessin linéaire (mis en cache : le tampon géodésique coûte quelques millisecondes). */
function couloirDe(d) {
  if (typeof window.turf === 'undefined') return null;
  const cle = `${JSON.stringify(d.points)}|${kmCouloir(d)}`;
  if (!state.cacheCouloirs.has(cle)) {
    if (state.cacheCouloirs.size > CACHE_COULOIRS_MAX) state.cacheCouloirs.clear();
    state.cacheCouloirs.set(cle, couloir(window.turf, d.points, kmCouloir(d)));
  }
  return state.cacheCouloirs.get(cle);
}

export function collection() {
  const traces = state.dessins.map((d) => ({ type: 'Feature',
    properties: { id: d.id, genre: d.genre, camp: d.camp, choisi: d.id === state.selection },
    geometry: d.genre === 'zone' ? { type: 'Polygon', coordinates: [[...d.points, d.points[0]]] } : { type: 'LineString', coordinates: d.points } }));
  const couloirs = !state.couloirs ? [] : state.dessins.filter((d) => d.genre !== 'zone').map((d) => [d, couloirDe(d)]).filter(([, c]) => c)
    .map(([d, c]) => ({ type: 'Feature', properties: { id: d.id, genre: 'couloir', camp: d.camp }, geometry: c.geometry }));
  return { type: 'FeatureCollection', features: [...couloirs, ...traces] };
}

export function collectionBrouillon() {
  const pts = state.curseur && !state.fige ? [...state.brouillon, state.curseur] : state.brouillon;
  const features = state.brouillon.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
  if (pts.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
  return { type: 'FeatureCollection', features };
}

function rafraichir() {
  if (!state.map) return;
  const a = state.map.getSource(SOURCE_DESSINS); if (a) a.setData(collection());
  const b = state.map.getSource(SOURCE_BROUILLON); if (b) b.setData(collectionBrouillon());
}

// ---------- outils ----------
function aideTexte() {
  const n = state.brouillon.length;
  if (state.outil === 'selection') return 'Cliquez un dessin pour le modifier. Choisissez un outil pour tracer.';
  if (state.outil === 'mesure') {
    const total = longueurKm(state.curseur && !state.fige ? [...state.brouillon, state.curseur] : state.brouillon);
    if (!n) return 'Cliquez pour poser le premier point de la mesure.';
    return state.fige ? `Mesure : ${formatKm(total)} · cliquez pour en commencer une autre · Échap pour effacer`
      : `Distance : ${formatKm(total)} · double-clic ou Entrée pour figer · Échap pour effacer`;
  }
  const detail = n ? ` · ${n} point${n > 1 ? 's' : ''}, ${formatKm(longueurKm(state.brouillon))}` : '';
  return `${OUTILS[state.outil]} : cliquez pour poser les points${detail} · double-clic ou Entrée pour terminer · Retour arrière pour annuler le dernier point`;
}

function dessinerOutils() {
  const boutons = Object.entries(OUTILS).map(([cle, nom]) => h('button', { type: 'button', 'aria-pressed': String(state.outil === cle), onclick: () => setOutil(cle) }, nom));
  const camps = Object.entries(NOM_CAMP).map(([camp, nom]) => h('button', { type: 'button', class: 'cellule-camp', 'data-tip': `Les prochains tracés seront ${nom.toLowerCase()}`,
    'aria-pressed': String(state.camp === camp), style: `--c:${camp === 'neutre' ? NEUTRE[state.theme] : COULEURS[camp]}`,
    onclick: () => { state.camp = camp; dessinerOutils(); } }, nom));
  const bascule = h('button', { type: 'button', 'aria-pressed': String(state.couloirs), onclick: basculerCouloirs, class: 'bord-droit',
    'data-tip': 'Montre la zone de part et d\'autre des lignes de front et des limites (30 km par défaut, réglable par ligne)' }, 'Couloirs');
  $('outils').replaceChildren(...boutons, h('span', { class: 'sep' }), h('span', { class: 'etiquette' }, 'Camp du tracé'), ...camps, h('span', { class: 'sep' }), bascule);
  $('aide-dessin').textContent = aideTexte();
  $('aide-dessin').style.display = state.outil === 'selection' && !state.selection ? 'none' : '';
}

export function setOutil(outil) {
  state.outil = outil; state.brouillon = []; state.curseur = null; state.fige = false;
  const dessine = outil !== 'selection';
  if (state.map) {
    state.map.getCanvas().style.cursor = dessine ? 'crosshair' : '';
    if (dessine) state.map.doubleClickZoom.disable(); else state.map.doubleClickZoom.enable();
  }
  if (dessine) { choisir(null); document.dispatchEvent(new CustomEvent('wg:outil', { detail: 'dessin' })); }
  dessinerOutils(); rafraichir();
}

function basculerCouloirs() {
  state.couloirs = !state.couloirs;
  try { localStorage.setItem(STORAGE_COULOIRS, state.couloirs ? 'oui' : 'non'); } catch { /* stockage indisponible */ }
  dessinerOutils(); rafraichir();
}

function ajouterPoint(lngLat) {
  if (state.fige) { state.brouillon = []; state.fige = false; }
  state.brouillon = [...state.brouillon, [lngLat.lng, lngLat.lat]];
  dessinerOutils(); rafraichir();
}

function terminer() {
  const n = state.brouillon.length;
  if (n < POINTS_MIN[state.outil]) return;
  if (state.outil === 'mesure') { state.fige = true; state.curseur = null; dessinerOutils(); rafraichir(); return; }
  const genre = state.outil;
  const numero = state.dessins.filter((d) => d.genre === genre).length + 1;
  const d = { id: newId(), genre, nom: `${NOM_GENRE[genre]} ${numero}`, camp: state.camp, points: state.brouillon };
  state.dessins = [...state.dessins, d]; sauver();
  state.brouillon = []; state.curseur = null;
  choisir(d.id, { garderOutil: true });
}

/** Ajoute un tracé par programme (assistant) : mêmes champs qu'un tracé fait à la main. */
export function ajouterDessin({ genre, camp, points, nom }) {
  const numero = state.dessins.filter((d) => d.genre === genre).length + 1;
  const d = { id: newId(), genre, nom: nom || `${NOM_GENRE[genre]} ${numero}`, camp, points };
  state.dessins = [...state.dessins, d]; sauver();
  dessinerListe(); rafraichir();
  return d.id;
}
export const listerDessins = () => state.dessins.map((d) => ({ ...d }));

function annulerDernierPoint() {
  state.brouillon = state.brouillon.slice(0, -1);
  dessinerOutils(); rafraichir();
}

// ---------- sélection et édition ----------
export function choisir(id, { garderOutil = false } = {}) {
  state.selection = id;
  if (id) document.dispatchEvent(new CustomEvent('wg:selection', { detail: 'dessin' }));
  if (id && state.outil !== 'selection' && !garderOutil) state.outil = 'selection';
  majPoignees(); dessinerFiche(); dessinerListe(); dessinerOutils(); rafraichir();
}

function majPoignees() {
  state.poignees.forEach((m) => m.remove());
  state.poignees = [];
  const d = dessin(state.selection);
  if (!d || !state.map) return;
  d.points.forEach((p, i) => {
    const el = h('div', { class: 'poignee', title: 'Glisser pour déplacer · clic droit pour supprimer ce point' });
    el.addEventListener('click', (ev) => ev.stopPropagation());
    el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); supprimerPoint(d.id, i); });
    const m = new maplibre.Marker({ element: el, draggable: true }).setLngLat(p).addTo(state.map);
    m.on('drag', () => { const { lng, lat } = m.getLngLat(); state.dessins = state.dessins.map((x) => (x.id === d.id ? { ...x, points: x.points.map((q, j) => (j === i ? [lng, lat] : q)) } : x)); rafraichir(); });
    m.on('dragend', () => { sauver(); dessinerFiche(); dessinerListe(); });
    state.poignees.push(m);
  });
}

function supprimerPoint(id, index) {
  const d = dessin(id);
  if (!d || d.points.length <= POINTS_MIN[d.genre]) return;
  maj(id, { points: d.points.filter((_, i) => i !== index) });
  majPoignees(); dessinerFiche(); dessinerListe(); rafraichir();
}

function supprimer(id) {
  state.dessins = state.dessins.filter((d) => d.id !== id); sauver();
  if (state.selection === id) { state.selection = null; majPoignees(); }
  dessinerFiche(); dessinerListe(); dessinerOutils(); rafraichir();
}

function mesures(d) {
  return d.genre === 'zone' ? `Périmètre ${formatKm(longueurKm([...d.points, d.points[0]]))} · surface ${formatSurface(aireKm2(d.points))}` : `Longueur ${formatKm(longueurKm(d.points))}`;
}

function dessinerFiche() {
  const d = dessin(state.selection);
  const boite = $('dessin-fiche');
  if (!d) { boite.replaceChildren(h('p', { class: 'note' }, 'Aucun dessin sélectionné.')); return; }
  const nom = h('input', { type: 'text', value: d.nom, maxlength: 60 });
  nom.addEventListener('input', () => { maj(d.id, { nom: nom.value.slice(0, 60) }); dessinerListe(); });
  const camps = h('div', { class: 'camps' }, ...Object.entries(NOM_CAMP).map(([camp, libelle]) => h('button', { type: 'button', class: 'camp', 'aria-pressed': String(d.camp === camp),
    style: `--c:${camp === 'neutre' ? NEUTRE[state.theme] : COULEURS[camp]}`, onclick: () => { maj(d.id, { camp }); dessinerFiche(); rafraichir(); } }, libelle)));
  boite.replaceChildren(...[h('label', { class: 'champ large' }, h('span', {}, 'Nom'), nom), camps,
    h('p', { class: 'note' }, `${NOM_GENRE[d.genre]} · ${d.points.length} points`), h('p', { class: 'note' }, mesures(d)),
    d.genre === 'zone' ? null : h('label', { class: 'champ' }, h('span', {}, 'Couloir'), reglageCouloir(d), h('em', {}, 'km de chaque côté')),
    h('p', { class: 'note' }, 'Glissez les carrés pour déplacer un point, clic droit pour en retirer un.'),
    h('button', { class: 'danger', type: 'button', onclick: () => supprimer(d.id) }, 'Supprimer le dessin')].filter(Boolean));
}

function reglageCouloir(d) {
  const champ = h('input', { type: 'text', inputmode: 'decimal', value: String(kmCouloir(d)).replace('.', ',') });
  champ.addEventListener('input', () => {
    const km = Number(champ.value.replace(',', '.'));
    if (Number.isFinite(km) && km >= 0 && km <= 1000) { maj(d.id, { couloir_km: km }); rafraichir(); }
  });
  return champ;
}

function dessinerListe() {
  const liste = $('dessins-liste');
  if (!state.dessins.length) { liste.replaceChildren(); return; }
  liste.replaceChildren(...state.dessins.map((d) => h('button', { type: 'button', class: `modele${d.id === state.selection ? ' arme' : ''}`, onclick: () => choisir(d.id),
    style: `--c:${d.camp === 'neutre' ? NEUTRE[state.theme] : COULEURS[d.camp]}` },
  h('span', { class: 'txt' }, h('b', {}, d.nom), h('small', {}, mesures(d))))));
}

// ---------- montage ----------
export function monter(map) {
  state.map = map;
  state.dessins = charger();
  map.on('click', (e) => {
    if (state.outil !== 'selection') { ajouterPoint(e.lngLat); return; }
    if (document.body.dataset.pieceArmee === 'oui' || document.body.dataset.pointage === 'oui') return;
    const { x, y } = e.point;
    const trouves = map.queryRenderedFeatures([[x - MARGE_CLIC_PX, y - MARGE_CLIC_PX], [x + MARGE_CLIC_PX, y + MARGE_CLIC_PX]], { layers: SELECTABLES });
    const id = trouves.length ? trouves[0].properties.id : null;
    if (id !== state.selection) choisir(id);
  });
  map.on('dblclick', (e) => {
    if (state.outil === 'selection') return;
    e.preventDefault();
    if (state.brouillon.length > 1) state.brouillon = state.brouillon.slice(0, -1); // le 2e clic du double-clic a posé un point en double
    terminer();
  });
  map.on('mousemove', (e) => {
    if (state.outil === 'selection' || !state.brouillon.length || state.fige) return;
    state.curseur = [e.lngLat.lng, e.lngLat.lat];
    $('aide-dessin').textContent = aideTexte(); rafraichir();
  });
  document.addEventListener('wg:outil', (e) => { if (e.detail === 'piece' && state.outil !== 'selection') setOutil('selection'); });
  document.addEventListener('wg:selection', (e) => { if (e.detail === 'piece' && state.selection) choisir(null); });
  document.addEventListener('keydown', (e) => {
    const saisie = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (state.brouillon.length) { state.brouillon = []; state.curseur = null; state.fige = false; dessinerOutils(); rafraichir(); }
      else if (state.outil !== 'selection') setOutil('selection');
      else if (state.selection) choisir(null);
    } else if (e.key === 'Enter' && state.outil !== 'selection' && !saisie) terminer();
    else if (e.key === 'Backspace' && !saisie) {
      if (state.outil !== 'selection' && state.brouillon.length) { e.preventDefault(); annulerDernierPoint(); }
      else if (state.selection) { e.preventDefault(); supprimer(state.selection); }
    } else if (e.key === 'Delete' && !saisie && state.selection) { e.preventDefault(); supprimer(state.selection); }
  });
  dessinerOutils(); dessinerFiche(); dessinerListe(); rafraichir();
}

export function majTheme() { dessinerOutils(); dessinerFiche(); dessinerListe(); }
