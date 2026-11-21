// Impacts : un flash au moment du tir et un cratère qui reste sur la carte. L'arbitre les crée (simulation), les joueurs les reçoivent avec l'état publié.
import * as maplibre from './vendor/maplibre-gl.mjs';
import { distanceKm } from './geo.js';
import { estJoueur, role } from './role.js';
import { ecrireJson, h, lireJson, sourceGeojson } from './ui.js';

export const SOURCE_IMPACTS = 'impacts';
const STOCK = 'wg.impacts.v1';
const MAX = 60;
const DUREE_FLASH_MS = 1800;
const DUREE_FUMEE_MS = 14000;
const VOL_MIN_MS = 450;
const VOL_MAX_MS = 1500;
const MS_PAR_KM = 90;
const METRES_PAR_PIXEL_Z0 = 156543.03;

let liste = estJoueur() ? [] : lireJson(STOCK, []);
let carte = null;
let connus = null; // identifiants déjà vus : un joueur qui arrive ne rejoue pas les anciens flashs
const cle = (i) => `${i.t}|${i.lng}|${i.lat}`;
const vuLe = new Map(); // quand ce navigateur a appris l'impact : le cratère n'apparaît qu'une fois l'obus arrivé
const trajet = (i) => (Array.isArray(i.de) && (!estJoueur() || i.camp === role.camp) ? i.de : null); // un joueur ne voit pas d'où l'adversaire tire
const dureeVol = (i) => {
  const de = trajet(i);
  return de ? Math.min(VOL_MAX_MS, Math.max(VOL_MIN_MS, distanceKm(de, [i.lng, i.lat]) * MS_PAR_KM)) : 0;
};

export const listerImpacts = () => liste.map((i) => ({ ...i }));

const nombre = (x) => typeof x === 'number' && Number.isFinite(x);
const valide = (i) => i && nombre(i.lng) && nombre(i.lat) && nombre(i.t) && ['frappe', 'zone', 'tir'].includes(i.genre) && (i.de === undefined || (Array.isArray(i.de) && i.de.length === 2 && i.de.every(nombre)));

export function collection() {
  return {
    type: 'FeatureCollection',
    features: liste.filter((i) => Date.now() - (vuLe.get(cle(i)) || 0) >= dureeVol(i)).map((i) => ({
      type: 'Feature',
      properties: { genre: i.genre, px0: Math.max(i.rayonM || 6, 4) / (METRES_PAR_PIXEL_Z0 * Math.cos((i.lat * Math.PI) / 180)) },
      geometry: { type: 'Point', coordinates: [i.lng, i.lat] }
    }))
  };
}
const rafraichir = sourceGeojson(() => carte, SOURCE_IMPACTS, collection);

export function layerSpecs() {
  const rayon = ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'px0'], 22, ['*', ['get', 'px0'], 4194304]];
  return [
    { id: 'impact-point', type: 'circle', source: SOURCE_IMPACTS, paint: { 'circle-radius': 3.5, 'circle-color': '#15110e', 'circle-stroke-width': 1.2, 'circle-stroke-color': '#ff9a3c', 'circle-pitch-alignment': 'map' } },
    { id: 'impact-halo', type: 'circle', source: SOURCE_IMPACTS, paint: { 'circle-radius': rayon, 'circle-color': '#ff7a1a', 'circle-opacity': 0.16, 'circle-pitch-alignment': 'map' } },
    {
      id: 'impact-cratere',
      type: 'circle',
      source: SOURCE_IMPACTS,
      paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['*', ['get', 'px0'], 0.45], 22, ['*', ['get', 'px0'], 0.45 * 4194304]], 'circle-color': '#0b0b0c', 'circle-opacity': 0.8, 'circle-stroke-width': 1, 'circle-stroke-color': '#ff9a3c', 'circle-stroke-opacity': 0.7, 'circle-pitch-alignment': 'map' }
    }
  ];
}

/** Le flash : une boule de feu qui gonfle puis s'éteint, et une onde. Retiré tout seul. */
function flash(i, grandeur = i.genre) {
  if (!carte) return;
  const el = h('div', { class: `impact-flash impact-${grandeur}` }, h('i', {}), h('b', {}));
  const m = new maplibre.Marker({ element: el, pitchAlignment: 'viewport' }).setLngLat([i.lng, i.lat]).addTo(carte);
  setTimeout(() => m.remove(), DUREE_FLASH_MS);
}

/** Fumée : un panache sombre qui monte, s'élargit et s'efface lentement. */
function fumee(i) {
  if (!carte) return;
  const el = h('div', { class: 'impact-fumee' }, h('i', {}), h('i', {}), h('i', {}));
  const m = new maplibre.Marker({ element: el, pitchAlignment: 'viewport' }).setLngLat([i.lng, i.lat]).addTo(carte);
  setTimeout(() => m.remove(), DUREE_FUMEE_MS);
}

/** L'obus : un point qui suit une courbe du canon à l'impact (monte puis retombe), précédé d'un éclair à la bouche du canon. */
function obus(i, duree, fin) {
  const de = trajet(i);
  const el = h('div', { class: 'obus' }, h('i', {}));
  const point = el.firstChild;
  const m = new maplibre.Marker({ element: el, pitchAlignment: 'viewport' }).setLngLat(de).addTo(carte);
  flash({ lng: de[0], lat: de[1] }, 'tir');
  const debut = performance.now();
  const hauteur = Math.min(90, 20 + distanceKm(de, [i.lng, i.lat]) * 6);
  const pas = (maintenant) => {
    const k = Math.min(1, (maintenant - debut) / duree);
    m.setLngLat([de[0] + (i.lng - de[0]) * k, de[1] + (i.lat - de[1]) * k]);
    point.style.transform = `translateY(${-Math.sin(Math.PI * k) * hauteur}px)`;
    if (k < 1) requestAnimationFrame(pas);
    else {
      m.remove();
      fin();
    }
  };
  requestAnimationFrame(pas);
}

/** Toute la séquence d'un tir : départ du coup, trajet de l'obus s'il y en a un, puis explosion, fumée et cratère. */
function jouer(i) {
  vuLe.set(cle(i), Date.now());
  const arrivee = () => {
    flash(i);
    if (i.genre !== 'tir') fumee(i);
    rafraichir();
  };
  const duree = dureeVol(i);
  if (duree > 0) obus(i, duree, arrivee);
  else arrivee();
  setTimeout(rafraichir, duree + 50); // le cratère apparaît à l'arrivée
}

function ajouter(i, animer) {
  liste = [...liste, i].slice(-MAX);
  if (animer) jouer(i);
  else vuLe.set(cle(i), 0);
}

/** Arbitre : un tir vient d'avoir lieu. */
export function enregistrerImpact({ lng, lat, rayonM = 0, genre, t, de, camp }) {
  const i = { lng, lat, rayonM, genre, t, ...(de ? { de, camp } : {}) };
  if (!valide(i)) return;
  connus && connus.add(cle(i));
  ajouter(i, true);
  ecrireJson(STOCK, liste);
  rafraichir();
}

/** Joueur : liste publiée par l'arbitre. Le premier envoi n'anime rien ; les suivants animent seulement les impacts nouveaux. */
export function remplacerImpacts(recus) {
  const propres = (Array.isArray(recus) ? recus : []).filter(valide).slice(-MAX);
  const premiere = connus === null;
  connus = connus || new Set();
  const neufs = propres.filter((i) => !connus.has(cle(i)));
  for (const i of neufs) connus.add(cle(i));
  liste = propres;
  for (const i of liste) if (!vuLe.has(cle(i))) vuLe.set(cle(i), 0);
  if (!premiere) for (const i of neufs.slice(-6)) jouer(i);
  rafraichir();
}

export function monter(map) {
  carte = map;
  rafraichir();
}
