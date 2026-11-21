// Impacts : un flash au moment du tir et un cratère qui reste sur la carte. L'arbitre les crée (simulation), les joueurs les reçoivent avec l'état publié.
import * as maplibre from './vendor/maplibre-gl.mjs';
import { estJoueur } from './role.js';
import { ecrireJson, h, lireJson, sourceGeojson } from './ui.js';

export const SOURCE_IMPACTS = 'impacts';
const STOCK = 'wg.impacts.v1';
const MAX = 60;
const DUREE_FLASH_MS = 1800;
const METRES_PAR_PIXEL_Z0 = 156543.03;

let liste = estJoueur() ? [] : lireJson(STOCK, []);
let carte = null;
let connus = null; // identifiants déjà vus : un joueur qui arrive ne rejoue pas les anciens flashs
const cle = (i) => `${i.t}|${i.lng}|${i.lat}`;

export const listerImpacts = () => liste.map((i) => ({ ...i }));

const nombre = (x) => typeof x === 'number' && Number.isFinite(x);
const valide = (i) => i && nombre(i.lng) && nombre(i.lat) && nombre(i.t) && ['frappe', 'zone', 'tir'].includes(i.genre);

export function collection() {
  return {
    type: 'FeatureCollection',
    features: liste.map((i) => ({
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
function flash(i) {
  if (!carte) return;
  const el = h('div', { class: `impact-flash impact-${i.genre}` }, h('i', {}), h('b', {}));
  const m = new maplibre.Marker({ element: el, pitchAlignment: 'viewport' }).setLngLat([i.lng, i.lat]).addTo(carte);
  setTimeout(() => m.remove(), DUREE_FLASH_MS);
}

function ajouter(i, animer) {
  liste = [...liste, i].slice(-MAX);
  if (animer) flash(i);
}

/** Arbitre : un tir vient d'avoir lieu. */
export function enregistrerImpact({ lng, lat, rayonM = 0, genre, t }) {
  const i = { lng, lat, rayonM, genre, t };
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
  if (!premiere) for (const i of neufs.slice(-6)) flash(i);
  rafraichir();
}

export function monter(map) {
  carte = map;
  rafraichir();
}
