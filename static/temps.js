import { estJoueur } from './role.js';
import { PARIS, heure, date, etiquetteDecalage, nomZone, ecartAvecParis, parisVersMs, msVersParis } from './fuseaux.js';

const VITESSES = [[1, '×1 (temps réel)'], [10, '×10'], [60, '×60 (1 min par seconde)'], [300, '×300'], [1800, '×1800 (30 min par seconde)']];
const ZOOM_LOCAL_MIN = 3;  // en dessous, le « centre de la carte » ne désigne plus un lieu
const PAS_MS = 250;
const LAT_MAX = 89.9;

// Une seule horloge de jeu : par défaut elle suit l'heure réelle. Les heures sont des millisecondes UTC.
const state = { ms: Date.now(), ancre: performance.now(), vitesse: 1, enMarche: true, dernier: Date.now(), abonnes: [], centre: { lng: 0, lat: 0, zoom: 0 } };
const $ = (id) => document.getElementById(id);

export function maintenant() { return state.enMarche ? state.ms + (performance.now() - state.ancre) * state.vitesse : state.ms; }
export const enMarche = () => state.enMarche;
export const vitesse = () => state.vitesse;
export function surTick(fn) { state.abonnes.push(fn); }

function figer() { state.ms = maintenant(); state.ancre = performance.now(); }
export function regler(ms) { state.ms = ms; state.ancre = performance.now(); state.dernier = ms; afficher(); }
export function demarrer() { figer(); state.enMarche = true; state.dernier = state.ms; panneau(); }
export function arreter() { figer(); state.enMarche = false; panneau(); }
export function reglerVitesse(v) { figer(); state.vitesse = v; panneau(); afficher(); }
/** Horloge d'un joueur : elle suit celle de l'arbitre (heure, vitesse, marche ou pause), sans qu'il puisse la régler. */
export function synchroniserHorloge(h) {
  if (!h) return;
  state.ms = h.ms; state.ancre = performance.now(); state.dernier = h.ms; state.vitesse = h.vitesse; state.enMarche = h.enMarche;
  afficher();
}
export function heureReelle() { state.vitesse = 1; state.enMarche = true; regler(Date.now()); panneau(); }

/** Fuseau du point au centre de la carte, ou null si la vue est trop large pour désigner un lieu. */
export function zoneLocale() {
  const { lng, lat, zoom } = state.centre;
  if (zoom < ZOOM_LOCAL_MIN || typeof window.tzlookup !== 'function') return null;
  try { return window.tzlookup(Math.max(-LAT_MAX, Math.min(LAT_MAX, lat)), ((lng + 540) % 360) - 180); } catch { return null; }
}

function afficher() {
  const t = maintenant();
  const zone = zoneLocale();
  const paris = `<b>Paris</b> ${date(t, PARIS)} ${heure(t, PARIS)} <em>${etiquetteDecalage(t, PARIS)}</em>`;
  let local = '<span class="discret"><b>Local</b> zoomez sur une zone</span>';
  if (zone) {
    const ecart = ecartAvecParis(t, zone);
    const diff = ecart === 0 ? 'même heure' : `${ecart > 0 ? '+' : '−'}${Math.abs(ecart).toString().replace('.', ',')} h`;
    local = `<b>${nomZone(zone)}</b> ${date(t, zone)} ${heure(t, zone)} <em>${etiquetteDecalage(t, zone)} · ${diff}</em>`;
  }
  const boite = $('horloges');
  if (!boite.firstChild) boite.innerHTML = '<span id="h-paris"></span><span id="h-local"></span><button type="button" class="etat" id="h-etat"></button>'; // structure fixe : le bouton ne change pas sous la souris
  $('h-paris').innerHTML = paris; $('h-local').innerHTML = local; // contenu entièrement produit ici (aucune donnée saisie)
  const etat = $('h-etat');
  etat.textContent = state.enMarche ? `×${state.vitesse}` : 'Pause';
  etat.dataset.tip = state.enMarche ? 'Mettre le temps de jeu en pause' : 'Reprendre le temps de jeu';
}

function tick() {
  const t = maintenant();
  const dt = t - state.dernier;
  state.dernier = t;
  if (dt > 0) for (const fn of state.abonnes) fn(t, dt);
  afficher();
}

// ---------- panneau « Temps de jeu » ----------
function bouton(texte, onclick) { const b = document.createElement('button'); Object.assign(b, { type: 'button', textContent: texte }); b.addEventListener('click', onclick); return b; }

function panneau() {
  const boite = $('temps-panneau');
  const vit = document.createElement('select');
  for (const [v, nom] of VITESSES) vit.append(Object.assign(document.createElement('option'), { value: String(v), textContent: nom, selected: v === state.vitesse }));
  vit.addEventListener('change', () => reglerVitesse(Number(vit.value)));
  const saisie = Object.assign(document.createElement('input'), { type: 'datetime-local', value: msVersParis(maintenant()) });
  const regl = bouton('Régler', () => { const ms = parisVersMs(saisie.value); if (ms !== null) regler(ms); });
  const ligne = document.createElement('div'); ligne.className = 'camps';
  ligne.append(bouton(state.enMarche ? 'Pause' : 'Lecture', () => (state.enMarche ? arreter() : demarrer())), bouton('Heure réelle', heureReelle));
  const note = Object.assign(document.createElement('p'), { className: 'note', textContent: "Heure de Paris. L'heure locale affichée en haut est celle du centre de la carte, dès qu'on zoome sur une zone." });
  boite.replaceChildren(ligne, vit, saisie, regl, note);
}

export function monter(map) {
  const maj = () => { const c = map.getCenter(); state.centre = { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; };
  map.on('move', maj); maj();
  $('horloges').addEventListener('click', (e) => { if (e.target.closest('.etat') && !estJoueur()) { if (state.enMarche) arreter(); else demarrer(); afficher(); } });
  panneau(); afficher();
  setInterval(tick, PAS_MS);
}
