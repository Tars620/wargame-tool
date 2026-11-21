import { estJoueur } from './role.js';
import { PARIS, heure, date, etiquetteDecalage, nomZone, ecartAvecParis, parisVersMs, msVersParis } from './fuseaux.js';

const VITESSES = [[1, '×1', 'Temps réel'], [10, '×10', '10 s de jeu par seconde'], [60, '×60', '1 min de jeu par seconde'], [300, '×300', '5 min de jeu par seconde'], [1800, '×1800', '30 min de jeu par seconde']];
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
export function demarrer() { figer(); state.enMarche = true; state.dernier = state.ms; majCommandes(); }
export function arreter() { figer(); state.enMarche = false; majCommandes(); }
export function reglerVitesse(v) { figer(); state.vitesse = v; majCommandes(); afficher(); }
/** Horloge d'un joueur : elle suit celle de l'arbitre (heure, vitesse, marche ou pause), sans qu'il puisse la régler. */
export function synchroniserHorloge(h) {
  if (!h) return;
  state.ms = h.ms; state.ancre = performance.now(); state.dernier = h.ms; state.vitesse = h.vitesse; state.enMarche = h.enMarche;
  afficher();
}
/** Revient à l'heure réelle : vitesse normale, en marche. */
export function heureReelle() { state.vitesse = 1; state.enMarche = true; regler(Date.now()); majCommandes(); }

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
  if (!boite.firstChild) boite.innerHTML = '<span id="h-paris" class="h-paris"></span><span id="h-local"></span><span id="h-pause" class="pause"></span>'; // structure fixe : rien ne change sous la souris
  $('h-paris').innerHTML = paris; $('h-local').innerHTML = local; // contenu entièrement produit ici (aucune donnée saisie)
  const pause = state.enMarche ? '' : 'En pause';
  if ($('h-pause').textContent !== pause) $('h-pause').textContent = pause;
  majCommandes();
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

let basculerReglage = () => {};

/** Commandes du temps de jeu : un seul bouton « Temps » dans la barre du haut ; il déroule pause/lecture, vitesse, retour à maintenant et réglage de l'heure. */
function commandes() {
  const boite = $('temps-cmd');
  if (!boite || boite.dataset.pret) return;
  boite.dataset.pret = 'oui';
  const principal = bouton('Temps', () => ouvrirMenu(menu.hidden));
  principal.id = 'h-temps'; principal.setAttribute('aria-haspopup', 'menu'); principal.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.id = 'menu-temps'; menu.className = 'menu-temps'; menu.hidden = true; menu.setAttribute('role', 'menu');
  const entree = (texte, onclick, id, extra = {}) => {
    const b = bouton(texte, () => { onclick(); ouvrirMenu(false); });
    b.setAttribute('role', extra.role || 'menuitem'); if (id) b.id = id; if (extra.vitesse) b.dataset.vitesse = String(extra.vitesse); if (extra.groupe) b.classList.add('debut-groupe');
    return b;
  };
  const items = [entree('Pause', () => (state.enMarche ? arreter() : demarrer()), 'h-etat')];
  VITESSES.forEach(([v, nom, aide], k) => { const b = entree(`${nom}  ${aide}`, () => reglerVitesse(v), null, { role: 'menuitemradio', vitesse: v, groupe: k === 0 }); items.push(b); });
  items.push(entree('Maintenant', heureReelle, 'h-maintenant', { groupe: true }), entree('Régler la date et l\'heure…', () => basculerReglage(true), null));
  menu.replaceChildren(...items);
  boite.replaceChildren(principal, menu);
  function ouvrirMenu(ouvert) {
    menu.hidden = !ouvert; principal.setAttribute('aria-expanded', String(ouvert));
    if (ouvert) majCommandes();
  }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !boite.contains(e.target)) ouvrirMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { ouvrirMenu(false); principal.focus(); } });
}

function majCommandes() {
  const b = $('h-etat');
  if (!b) return;
  const texte = state.enMarche ? 'Pause' : 'Reprendre';
  if (b.textContent !== texte) b.textContent = texte;
  for (const v of document.querySelectorAll('#menu-temps [data-vitesse]')) v.setAttribute('aria-checked', String(Number(v.dataset.vitesse) === state.vitesse));
  const principal = $('h-temps');
  if (principal) principal.dataset.etat = state.enMarche ? 'marche' : 'pause';
}

/** Réglage d'une date et d'une heure précises (heure de Paris) : s'ouvre en cliquant l'heure de Paris. */
function reglageHeure() {
  const fenetre = $('reglage-heure');
  if (!fenetre) return;
  const saisie = Object.assign(document.createElement('input'), { type: 'datetime-local' });
  const fermer = () => { fenetre.hidden = true; };
  const appliquer = () => { const ms = parisVersMs(saisie.value); if (ms !== null) { regler(ms); fermer(); } };
  saisie.addEventListener('keydown', (e) => { if (e.key === 'Enter') appliquer(); else if (e.key === 'Escape') fermer(); });
  fenetre.replaceChildren(saisie, bouton('Régler', appliquer), Object.assign(document.createElement('p'), { className: 'note', textContent: 'Heure de Paris.' }));
  basculerReglage = (ouvrir) => {
    if (estJoueur()) return;
    fenetre.hidden = ouvrir === undefined ? !fenetre.hidden : !ouvrir;
    if (!fenetre.hidden) { saisie.value = msVersParis(maintenant()); saisie.focus(); }
  };
  $('horloges').addEventListener('click', (e) => { if (e.target.closest('.h-paris')) basculerReglage(); });
  document.addEventListener('mousedown', (e) => { if (!fenetre.hidden && !fenetre.contains(e.target) && !e.target.closest('.h-paris') && !e.target.closest('#menu-temps')) fermer(); });
}

export function monter(map) {
  const maj = () => { const c = map.getCenter(); state.centre = { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; };
  map.on('move', maj); maj();
  commandes(); reglageHeure(); afficher();
  setInterval(tick, PAS_MS);
}
