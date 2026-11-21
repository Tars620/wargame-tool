import * as maplibre from './vendor/maplibre-gl.mjs';
import { distanceKm, cercle, formatDuree, dureesDeplacement, formatKm } from './geo.js';
import { symbole } from './symboles.js';

export const SOURCE_ID = 'portees';
const STORAGE_KEY = 'wg.pieces.v1';
const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };
const NOM_CAMP = { bleu: 'Bleu', rouge: 'Rouge' };
const PUISSANCE_MAX = 10;
const state = { catalogue: [], pieces: [], camp: 'bleu', arme: null, selection: null, portees: 'selection', map: null,
  marqueurs: new Map(), racine: null, visibles: null };

// ---------- utilitaires DOM ----------
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

function nombre(valeur, min, max, repli) {
  const n = Number(String(valeur).replace(',', '.'));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : repli;
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const piece = (id) => state.pieces.find((p) => p.id === id) || null;

// ---------- persistance (navigateur) ----------
function sauver() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.pieces)); } catch { /* stockage indisponible */ } }
function charger() {
  try { const brut = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(brut) ? brut : []; } catch { return []; }
}

// ---------- état : jamais de modification en place ----------
function maj(id, patch) {
  state.pieces = state.pieces.map((p) => (p.id === id ? { ...p, ...patch } : p));
  sauver();
}

// ---------- couches de la carte ----------
const couleurDe = ['match', ['get', 'camp'], 'rouge', COULEURS.rouge, COULEURS.bleu];

export function layerSpecs() {
  return [
    { id: 'portee-vision-fond', type: 'fill', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'vision'], paint: { 'fill-color': couleurDe, 'fill-opacity': 0.09 } },
    { id: 'portee-vision', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'vision'], paint: { 'line-color': couleurDe, 'line-width': 1.2, 'line-opacity': 0.9 } },
    { id: 'portee-feu', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'feu'], paint: { 'line-color': couleurDe, 'line-width': 1.6, 'line-dasharray': [3, 2] } },
    { id: 'portee-trace', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'trace'], paint: { 'line-color': couleurDe, 'line-width': 1.6, 'line-dasharray': [1, 2], 'line-opacity': 0.8 } },
  ];
}

export function collection() {
  const montrees = state.pieces.filter((p) => estVisible(p) && !p.detruit);
  const visibles = state.portees === 'toutes' ? montrees : state.portees === 'selection' ? montrees.filter((p) => p.id === state.selection) : [];
  const features = [];
  for (const p of visibles) {
    const proprietes = { camp: p.camp, id: p.id };
    const centre = [p.lng, p.lat];
    if (p.vision.rayon_km > 0) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'vision' }, geometry: { type: 'Polygon', coordinates: [cercle(centre, p.vision.rayon_km)] } });
    if (p.feu.portee_km > 0) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'feu' }, geometry: { type: 'LineString', coordinates: cercle(centre, p.feu.portee_km) } });
    if (p.dernier_deplacement) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'trace' }, geometry: { type: 'LineString', coordinates: p.dernier_deplacement.trace } });
  }
  return { type: 'FeatureCollection', features };
}

function rafraichirCarte() {
  const source = state.map && state.map.getSource(SOURCE_ID);
  if (source) source.setData(collection());
}

// ---------- marqueurs ----------
const modeleDe = (p) => state.catalogue.find((m) => m.id === p.type) || { nom: p.nom };

function styleMarqueur(p, el) {
  el.style.setProperty('--c', COULEURS[p.camp]);
  if (el.dataset.camp !== p.camp) { el.replaceChildren(symbole(modeleDe(p), p.camp, 22)); el.dataset.camp = p.camp; } // l'identité du symbole suit le camp
  el.title = `${p.nom} (${NOM_CAMP[p.camp]})${p.detruit ? ', détruit' : ''}`;
  el.classList.toggle('choisi', p.id === state.selection);
  el.classList.toggle('detruit', !!p.detruit);
}

function ajouterMarqueur(p) {
  const el = h('button', { class: 'pion', type: 'button' });
  styleMarqueur(p, el);
  el.addEventListener('click', (ev) => { ev.stopPropagation(); choisir(p.id); });
  const marqueur = new maplibre.Marker({ element: el, draggable: true }).setLngLat([p.lng, p.lat]).addTo(state.map);
  let depart = null;
  marqueur.on('dragstart', () => { depart = [p.lng, p.lat]; choisir(p.id); });
  marqueur.on('dragend', () => { const { lng, lat } = marqueur.getLngLat(); deplacer(p.id, depart, [lng, lat]); });
  state.marqueurs.set(p.id, marqueur);
}

function majMarqueurs() {
  for (const p of state.pieces) { const m = state.marqueurs.get(p.id); if (m) styleMarqueur(p, m.getElement()); }
}

// ---------- actions ----------
function creer(type, lngLat) {
  const modele = state.catalogue.find((m) => m.id === type);
  const numero = state.pieces.filter((p) => p.type === type).length + 1;
  const p = { id: newId(), type, icone: modele.icone, nom: `${modele.nom} ${numero}`, camp: state.camp, lng: lngLat.lng, lat: lngLat.lat,
    mouvement: { ...modele.mouvement }, feu: { ...modele.feu }, vision: { ...modele.vision }, meteo_max: modele.meteo_max ? { ...modele.meteo_max } : null, dernier_deplacement: null };
  state.pieces = [...state.pieces, p];
  sauver(); ajouterMarqueur(p); choisir(p.id); signaler();
}

function deplacer(id, depart, arrivee) {
  const p = piece(id);
  if (!p || !depart) return;
  const km = distanceKm(depart, arrivee);
  maj(id, { lng: arrivee[0], lat: arrivee[1], dernier_deplacement: km < 0.001 ? null : { km, trace: [depart, arrivee] } });
  rafraichirCarte(); dessinerFiche(); signaler();
}

function supprimer(id) {
  const m = state.marqueurs.get(id);
  if (m) m.remove();
  state.marqueurs.delete(id);
  state.pieces = state.pieces.filter((p) => p.id !== id);
  sauver();
  if (state.selection === id) state.selection = null;
  rafraichirCarte(); dessinerFiche(); signaler();
}

function choisir(id) {
  state.selection = id;
  if (id) document.dispatchEvent(new CustomEvent('wg:selection', { detail: 'piece' }));
  document.dispatchEvent(new CustomEvent('wg:piece', { detail: { id } }));
  majMarqueurs(); rafraichirCarte(); dessinerFiche();
}

function armer(type) {
  state.arme = state.arme === type ? null : type;
  state.map.getCanvas().style.cursor = state.arme ? 'crosshair' : '';
  document.body.dataset.pieceArmee = state.arme ? 'oui' : 'non';
  if (state.arme) document.dispatchEvent(new CustomEvent('wg:outil', { detail: 'piece' }));
  dessinerBanque();
}

// ---------- panneau ----------
const fr = (x) => String(x).replace('.', ',');
function resume(m) {
  const feu = m.feu.portee_km > 0 ? `${fr(m.feu.portee_km)} km, puissance ${m.feu.puissance}` : 'aucun';
  return [`Mouvement : ${fr(m.mouvement.min)} à ${fr(m.mouvement.max)} km/h`, `Feu : ${feu}`, `Vision : ${fr(m.vision.rayon_km)} km`];
}

function dessinerBanque() {
  const boutons = Object.keys(NOM_CAMP).map((camp) => h('button', { class: 'camp', type: 'button', 'aria-pressed': String(state.camp === camp), style: `--c:${COULEURS[camp]}`,
    onclick: () => { state.camp = camp; dessinerBanque(); } }, NOM_CAMP[camp]));
  const cartes = state.catalogue.map((m) => h('button', { class: `modele${state.arme === m.id ? ' arme' : ''}`, type: 'button', onclick: () => armer(m.id), style: `--c:${COULEURS[state.camp]}` },
    h('span', { class: 'ico' }, symbole(m, state.camp, 22)), h('span', { class: 'txt' }, h('b', {}, m.nom), ...resume(m).map((l) => h('small', {}, l)))));
  const aide = state.arme ? 'Cliquez sur la carte pour poser. Échap pour arrêter.' : 'Choisissez un camp, une pièce, puis cliquez sur la carte.';
  $('banque').replaceChildren(h('div', { class: 'camps' }, boutons), ...cartes, h('p', { class: 'note' }, aide));
}

const $ = (id) => document.getElementById(id);

function champ(libelle, valeur, unite, onChange, props = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', value: String(valeur), ...props });
  input.addEventListener('input', () => onChange(input.value));
  return h('label', { class: 'champ' }, h('span', {}, libelle), input, unite ? h('em', {}, unite) : null);
}

function barrePuissance(valeur) {
  return h('span', { class: 'barre', role: 'img', 'aria-label': `puissance ${valeur} sur ${PUISSANCE_MAX}` },
    ...Array.from({ length: PUISSANCE_MAX }, (_, i) => h('i', { class: i < valeur ? 'plein' : '' })));
}

function phraseDeplacement(p) {
  if (!p.dernier_deplacement) return 'Aucun déplacement. Faites glisser la pièce sur la carte.';
  const { rapide, lent } = dureesDeplacement(p.dernier_deplacement.km, p.mouvement.min, p.mouvement.max);
  return `${formatKm(p.dernier_deplacement.km)} · ${formatDuree(rapide)} à ${formatDuree(lent)} (${fr(p.mouvement.min)} à ${fr(p.mouvement.max)} km/h)`;
}

function dessinerFiche() {
  const boite = $('fiche');
  const p = piece(state.selection);
  if (!p) { boite.replaceChildren(h('p', { class: 'note' }, 'Aucune pièce sélectionnée.')); return; }
  const modele = state.catalogue.find((m) => m.id === p.type);
  const barre = h('div', { class: 'ligne' }, barrePuissance(p.feu.puissance));
  const deplacement = h('p', { class: 'note' }, phraseDeplacement(p));
  const miseAJour = (patch) => { maj(p.id, patch); const q = piece(p.id); deplacement.textContent = phraseDeplacement(q); barre.replaceChildren(barrePuissance(q.feu.puissance)); rafraichirCarte(); majMarqueurs(); };
  const camps = h('div', { class: 'camps' }, ...Object.keys(NOM_CAMP).map((camp) => h('button', { class: 'camp', type: 'button', 'aria-pressed': String(p.camp === camp), style: `--c:${COULEURS[camp]}`,
    onclick: () => { maj(p.id, { camp }); majMarqueurs(); rafraichirCarte(); dessinerFiche(); } }, NOM_CAMP[camp])));
  boite.replaceChildren(...[
    champ('Nom', p.nom, '', (v) => { maj(p.id, { nom: v.slice(0, 60) }); majMarqueurs(); }, { class: 'large' }), camps,
    h('h4', {}, 'Mouvement'),
    h('div', { class: 'duo' },
      champ('Min', p.mouvement.min, 'km/h', (v) => miseAJour({ mouvement: { ...piece(p.id).mouvement, min: nombre(v, 0, 5000, p.mouvement.min) } })),
      champ('Max', p.mouvement.max, 'km/h', (v) => miseAJour({ mouvement: { ...piece(p.id).mouvement, max: nombre(v, 0, 5000, p.mouvement.max) } }))),
    deplacement,
    h('h4', {}, 'Feu'),
    h('div', { class: 'duo' },
      champ('Portée', p.feu.portee_km, 'km', (v) => miseAJour({ feu: { ...piece(p.id).feu, portee_km: nombre(v, 0, 5000, p.feu.portee_km) } })),
      champ('Puissance', p.feu.puissance, `/ ${PUISSANCE_MAX}`, (v) => miseAJour({ feu: { ...piece(p.id).feu, puissance: Math.round(nombre(v, 0, PUISSANCE_MAX, p.feu.puissance)) } }))),
    barre,
    h('h4', {}, 'Vision'),
    champ('Rayon', p.vision.rayon_km, 'km', (v) => miseAJour({ vision: { rayon_km: nombre(v, 0, 5000, p.vision.rayon_km) } })),
    modele && modele.avertissement ? h('p', { class: 'note' }, modele.avertissement) : null,
    h('p', { class: 'note' }, `Position : ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`),
    h('button', { class: 'danger', type: 'button', onclick: () => supprimer(p.id) }, 'Supprimer la pièce')].filter(Boolean));
}

function dessinerOptions() {
  const choix = [['selection', 'Pièce sélectionnée'], ['toutes', 'Toutes les pièces'], ['aucune', 'Aucune']];
  $('portees').replaceChildren(...choix.map(([valeur, libelle]) => h('label', { class: 'opt' },
    h('input', { type: 'radio', name: 'portees', value: valeur, checked: state.portees === valeur, onchange: () => { state.portees = valeur; rafraichirCarte(); } }), h('span', {}, libelle))),
  h('button', { class: 'danger', type: 'button', onclick: () => { if (state.pieces.length && confirm('Retirer toutes les pièces de la carte ?')) [...state.pieces].forEach((p) => supprimer(p.id)); } }, 'Tout effacer'));
}

// ---------- interface pour les consignes ----------
const estVisible = (p) => !state.visibles || state.visibles.has(p.id);
function signaler() { document.dispatchEvent(new CustomEvent('wg:pieces')); }

/** Crée plusieurs pièces d'un coup (assistant). `specs` : { vid, type, camp, lng, lat, nom }. Rend { vid: id réel }. */
export function creerPieces(specs) {
  const ids = {};
  for (const sp of specs) {
    const modele = state.catalogue.find((m) => m.id === sp.type);
    if (!modele) continue;
    const p = { id: newId(), type: sp.type, icone: modele.icone, nom: sp.nom, camp: sp.camp, lng: sp.lng, lat: sp.lat, mouvement: { ...modele.mouvement }, feu: { ...modele.feu },
      vision: { ...modele.vision }, meteo_max: modele.meteo_max ? { ...modele.meteo_max } : null, dernier_deplacement: null };
    state.pieces = [...state.pieces, p];
    ajouterMarqueur(p);
    ids[sp.vid] = p.id;
  }
  sauver(); rafraichirCarte(); signaler();
  return ids;
}

/** Une pièce détruite reste sur la carte (grisée) mais ne voit, ne tire et ne se déplace plus. */
export function detruire(id) {
  if (!piece(id)) return;
  maj(id, { detruit: true });
  majMarqueurs(); rafraichirCarte(); dessinerFiche(); signaler();
}

export function restaurer(id) {
  if (!piece(id) || !piece(id).detruit) return;
  maj(id, { detruit: false });
  majMarqueurs(); rafraichirCarte(); dessinerFiche(); signaler();
}

export const catalogue = () => state.catalogue.map((m) => ({ ...m }));
export const listerPieces = () => state.pieces.map((p) => ({ ...p }));
export const pieceChoisie = () => state.selection;
export const choisirPiece = (id) => choisir(id);

/** Déplace une pièce par programme (exécution d'une consigne). `trace` garde le point de départ pour le tracé. */
export function positionner(id, [lng, lat], trace = null) {
  const p = piece(id);
  if (!p) return;
  const depart = trace || [p.lng, p.lat];
  maj(id, { lng, lat, dernier_deplacement: trace ? { km: distanceKm(depart, [lng, lat]), trace: [depart, [lng, lat]] } : p.dernier_deplacement });
  const m = state.marqueurs.get(id);
  if (m) m.setLngLat([lng, lat]);
}

/** Limite l'affichage aux pièces dont l'identifiant est dans `ids` (point de vue d'un camp). null = tout voir. */
export function appliquerVisibilite(ids) {
  state.visibles = ids;
  for (const p of state.pieces) { const m = state.marqueurs.get(p.id); if (m) m.getElement().style.display = estVisible(p) ? '' : 'none'; }
  rafraichirCarte();
}

export function rafraichir() { rafraichirCarte(); dessinerFiche(); }

// ---------- montage ----------
export async function monter(map) {
  state.map = map;
  const reponse = await fetch('/static/pieces.json');
  state.catalogue = (await reponse.json()).pieces;
  state.pieces = charger();
  for (const p of state.pieces) ajouterMarqueur(p);
  map.on('click', (e) => {
    if (document.body.dataset.pointage === 'oui') return; // une consigne est en cours de pointage sur la carte
    if (state.arme) creer(state.arme, e.lngLat); else if (state.selection) choisir(null);
  });
  document.addEventListener('keydown', (e) => {
    const saisie = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape' && state.arme) armer(state.arme);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection && !saisie) { e.preventDefault(); supprimer(state.selection); }
  });
  document.addEventListener('wg:outil', (e) => { if (e.detail === 'dessin' && state.arme) armer(state.arme); });
  document.addEventListener('wg:selection', (e) => {
    if (e.detail === 'dessin' && state.selection) { state.selection = null; majMarqueurs(); rafraichirCarte(); dessinerFiche(); }
  });
  dessinerBanque(); dessinerFiche(); dessinerOptions(); rafraichirCarte();
}
