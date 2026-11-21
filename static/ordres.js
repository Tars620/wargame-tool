import { distanceKm, formatKm, formatDuree } from './geo.js';
import { ALLURES, avancer, contacts, verifier, visiblesPour, vitesse } from './moteur.js';
import { PARIS, date, heure } from './fuseaux.js';
import { maintenant, surTick, demarrer, enMarche } from './temps.js';
import { listerPieces, pieceChoisie, choisirPiece, positionner, appliquerVisibilite } from './pieces.js';
import { conditions } from './meteo.js';

export const SOURCE_CONSIGNES = 'consignes';
const STORAGE_ORDRES = 'wg.ordres.v1';
const STORAGE_JOURNAL = 'wg.journal.v1';
const JOURNAL_MAX = 300;
const JOURNAL_AFFICHE = 60;
const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };
const STATUTS = { attente: 'En attente', lance: 'Lancée', en_cours: 'En cours', terminee: 'Terminée' };
const TYPES = { aller: 'Aller à', observer: 'Observer', engager: 'Engager (feu)' };

const state = { map: null, ordres: {}, journal: [], lancee: false, depart: null, pointDeVue: 'arbitre', pointage: null,
  forme: { type: 'aller', allure: 'normale', dureeMin: 10, cibleId: '' }, contactsVus: new Set(), meteo: null, theme: 'sombre' };
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
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const lire = (cle, repli) => { try { return JSON.parse(localStorage.getItem(cle)) ?? repli; } catch { return repli; } };
const ecrire = (cle, valeur) => { try { localStorage.setItem(cle, JSON.stringify(valeur)); } catch { /* stockage indisponible */ } };
const sauver = () => { ecrire(STORAGE_ORDRES, state.ordres); ecrire(STORAGE_JOURNAL, state.journal); };
const nomDe = (pieces, id) => (pieces.find((p) => p.id === id) || { nom: 'pièce retirée' }).nom;
const km = (x) => formatKm(x);

// ---------- journal des opérations ----------
function noter(t, texte, genre = 'info') {
  state.journal = [{ t, texte, genre }, ...state.journal].slice(0, JOURNAL_MAX);
  sauver(); dessinerJournal();
}

function dessinerJournal() {
  const liste = $('journal-ops');
  if (!liste) return;
  if (!state.journal.length) { liste.replaceChildren(h('p', { class: 'note' }, 'Aucun événement. Les départs, arrivées, contacts et tirs apparaissent ici, à l\'heure de jeu.')); return; }
  liste.replaceChildren(...state.journal.slice(0, JOURNAL_AFFICHE).map((e) => h('div', { class: `evt evt-${e.genre}` },
    h('small', {}, `${date(e.t, PARIS)} ${heure(e.t, PARIS)} Paris`), h('span', {}, e.texte))),
  h('button', { type: 'button', class: 'danger', onclick: () => { state.journal = []; sauver(); dessinerJournal(); } }, 'Effacer le journal'));
}

// ---------- consignes ----------
const pieceCourante = () => listerPieces().find((p) => p.id === pieceChoisie()) || null;
const fileDe = (id) => state.ordres[id] || [];
function majFile(id, fn) { state.ordres = { ...state.ordres, [id]: fn(fileDe(id)) }; sauver(); }

function libelle(c, pieces) {
  if (c.type === 'aller') return `Aller à ${c.points.length > 1 ? `${c.points.length} points` : 'un point'} (${km(c.distanceKm || 0)}, allure ${ALLURES[c.allure].toLowerCase()})`;
  if (c.type === 'observer') return `Observer ${c.dureeMin} min`;
  return `Engager ${nomDe(pieces, c.cibleId)}`;
}

function nouvelleConsigne(piece) {
  const f = state.forme;
  const base = { id: newId(), type: f.type, allure: f.allure, statut: state.lancee ? 'lance' : 'attente' };
  if (f.type === 'aller') return { ...base, points: state.pointage ? state.pointage.points : (f.points || []) };
  if (f.type === 'observer') return { ...base, dureeMin: Number(f.dureeMin) };
  return { ...base, cibleId: f.cibleId };
}

async function bilan(piece, consigne, pieces) {
  let meteo = null;
  if (piece.meteo_max) { try { meteo = await conditions(piece.lng, piece.lat, maintenant()); } catch { meteo = null; } }
  return verifier(piece, consigne, { pieces, meteo });
}

async function dessinerBilan() {
  const zone = $('o-bilan');
  const piece = pieceCourante();
  if (!zone || !piece) return;
  const pieces = listerPieces();
  const c = nouvelleConsigne(piece);
  const r = await bilan(piece, c, pieces);
  const lignes = [];
  if (r.ok && c.type !== 'observer' && Number.isFinite(r.dureeMin)) {
    const arrivee = maintenant() + r.dureeMin * 60000;
    lignes.push(`${km(r.distanceKm)} · ${formatDuree(r.dureeMin)} · fin prévue ${heure(arrivee, PARIS)} (Paris)`);
  }
  const sansDestination = c.type === 'aller' && !(c.points && c.points.length);
  if (sansDestination) lignes.push('Choisissez la destination sur la carte (plusieurs points pour un itinéraire).');
  zone.replaceChildren(...lignes.map((t) => h('p', { class: 'note' }, t)), ...(sansDestination ? [] : r.erreurs).map((t) => h('p', { class: 'err' }, t)), ...r.avertissements.map((t) => h('p', { class: 'avert' }, t)));
  const bouton = $('o-ajouter');
  if (bouton) bouton.disabled = !r.ok;
}

async function ajouter() {
  const piece = pieceCourante();
  if (!piece) return;
  const pieces = listerPieces();
  let c = nouvelleConsigne(piece);
  const r = await bilan(piece, c, pieces);
  if (!r.ok) return;
  if (c.type === 'aller') c = { ...c, distanceKm: r.distanceKm };
  majFile(piece.id, (file) => [...file, c]);
  if (state.pointage) arreterPointage(false);
  state.forme = { ...state.forme, points: [] };
  dessinerConsignes(); rafraichirCarte();
}

function retirer(pieceId, id) { majFile(pieceId, (file) => file.filter((c) => c.id !== id)); dessinerConsignes(); rafraichirCarte(); }

// ---------- pointage sur la carte ----------
function demarrerPointage() {
  state.pointage = { points: [] };
  document.body.dataset.pointage = 'oui';
  state.map.getCanvas().style.cursor = 'crosshair'; state.map.doubleClickZoom.disable();
  dessinerConsignes(); rafraichirCarte();
}
/** Quitte le mode pointage. `garder` conserve les points posés (« Terminer »), sinon on les abandonne. */
function arreterPointage(garder = false) {
  const points = state.pointage ? state.pointage.points : [];
  state.pointage = null;
  document.body.dataset.pointage = 'non';
  state.map.getCanvas().style.cursor = ''; state.map.doubleClickZoom.enable();
  state.forme = { ...state.forme, points: garder ? points : [] };
  dessinerConsignes(); rafraichirCarte();
}
function pointer(lngLat) {
  state.pointage = { points: [...state.pointage.points, [lngLat.lng, lngLat.lat]] };
  state.forme = { ...state.forme, points: state.pointage.points };
  dessinerBilan(); rafraichirCarte();
}

// ---------- opération ----------
function lancer() {
  const pieces = listerPieces();
  if (!state.depart) state.depart = Object.fromEntries(pieces.map((p) => [p.id, [p.lng, p.lat]]));
  let n = 0;
  for (const [id, file] of Object.entries(state.ordres)) {
    state.ordres = { ...state.ordres, [id]: file.map((c) => { if (c.statut === 'attente') { n += 1; return { ...c, statut: 'lance' }; } return c; }) };
  }
  state.lancee = true; sauver();
  if (!enMarche()) demarrer();
  noter(maintenant(), n ? `Opération lancée : ${n} consigne${n > 1 ? 's' : ''} en cours d'exécution.` : 'Opération lancée (aucune consigne en attente).', 'op');
  dessinerOperation(); dessinerConsignes();
}

function revenirAuDepart() {
  if (state.depart) for (const [id, pos] of Object.entries(state.depart)) positionner(id, pos);
  for (const id of Object.keys(state.ordres)) {
    state.ordres = { ...state.ordres, [id]: fileDe(id).map((c) => ({ ...c, statut: 'attente', etape: 0, ecouleMin: 0 })) };
  }
  state.lancee = false; state.depart = null; state.contactsVus = new Set(); sauver();
  noter(maintenant(), 'Retour aux positions de départ : consignes remises en attente.', 'op');
  dessinerOperation(); dessinerConsignes(); rafraichirCarte(); majVisibilite();
}

function evenement(t, e, pieces) {
  const nom = nomDe(pieces, e.pieceId);
  if (e.type === 'arrivee') noter(t, `${nom} est arrivé à destination.`, 'info');
  else if (e.type === 'fin_observation') noter(t, `${nom} termine son observation.`, 'info');
  else if (e.type === 'cible_perdue') noter(t, `${nom} : cible introuvable, engagement annulé.`, 'alerte');
  else if (e.type === 'tir') noter(t, `TIR : ${nom} engage ${nomDe(pieces, e.cibleId)} (puissance ${e.puissance}, à ${km(e.distanceKm)}). Résultat à arbitrer.`, 'tir');
}

function pas(t, dtMs) {
  if (!state.lancee) return;
  const dtMin = dtMs / 60000;
  const pieces = listerPieces();
  let change = false;
  for (const piece of pieces) {
    const file = fileDe(piece.id);
    const i = file.findIndex((c) => c.statut === 'lance' || c.statut === 'en_cours');
    if (i < 0) continue;
    let c = file[i];
    if (c.statut === 'lance') { c = { ...c, statut: 'en_cours', debutMs: t, depart: [piece.lng, piece.lat] }; noter(t, `${piece.nom} : début « ${libelle(c, pieces)} ».`, 'info'); }
    const r = avancer(piece, c, dtMin, pieces);
    positionner(piece.id, r.position, r.termine && c.type !== 'observer' ? c.depart : null);
    for (const e of r.evenements) evenement(t, e, pieces);
    const suivi = r.termine ? { ...r.consigne, statut: 'terminee', finMs: t } : { ...r.consigne, statut: 'en_cours' };
    state.ordres = { ...state.ordres, [piece.id]: file.map((x, j) => (j === i ? suivi : x)) };
    change = true;
  }
  if (change) { sauver(); suivreContacts(t); dessinerConsignes(); rafraichirCarte(); }
  majVisibilite();
}

function suivreContacts(t) {
  const pieces = listerPieces();
  const maintenantVus = new Set(contacts(pieces).map((c) => `${c.observateurId}>${c.cibleId}`));
  for (const cle of maintenantVus) if (!state.contactsVus.has(cle)) {
    const [o, c] = cle.split('>');
    const d = distanceKm([pieces.find((p) => p.id === o).lng, pieces.find((p) => p.id === o).lat], [pieces.find((p) => p.id === c).lng, pieces.find((p) => p.id === c).lat]);
    noter(t, `CONTACT : ${nomDe(pieces, o)} repère ${nomDe(pieces, c)} à ${km(d)}.`, 'contact');
  }
  state.contactsVus = maintenantVus;
}

function majVisibilite() {
  if (state.pointDeVue === 'arbitre') { appliquerVisibilite(null); return; }
  appliquerVisibilite(visiblesPour(state.pointDeVue, listerPieces()));
}

// ---------- couches de la carte ----------
export function layerSpecs() {
  const couleur = ['match', ['get', 'camp'], 'rouge', COULEURS.rouge, 'bleu', COULEURS.bleu, '#c9ccd4'];
  return [
    { id: 'consigne-route', type: 'line', source: SOURCE_CONSIGNES, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': couleur, 'line-width': 1.6, 'line-dasharray': [1, 2], 'line-opacity': 0.9 } },
    { id: 'consigne-points', type: 'circle', source: SOURCE_CONSIGNES, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': couleur, 'circle-stroke-color': state.theme === 'sombre' ? '#000' : '#fff', 'circle-stroke-width': 1.2 } },
  ];
}

export function collection() {
  const pieces = listerPieces();
  const features = [];
  const tracer = (camp, coords) => { if (coords.length > 1) features.push({ type: 'Feature', properties: { camp }, geometry: { type: 'LineString', coordinates: coords } }); };
  for (const p of pieces) {
    const attente = fileDe(p.id).filter((c) => c.statut !== 'terminee');
    let courant = [p.lng, p.lat];
    for (const c of attente) {
      if (c.type === 'aller') {
        const restants = c.points.slice(c.etape || 0);
        tracer(p.camp, [courant, ...restants]);
        restants.forEach((q) => features.push({ type: 'Feature', properties: { camp: p.camp }, geometry: { type: 'Point', coordinates: q } }));
        if (restants.length) courant = restants[restants.length - 1];
      } else if (c.type === 'engager') {
        const cible = pieces.find((q) => q.id === c.cibleId);
        if (cible) tracer(p.camp, [courant, [cible.lng, cible.lat]]);
      }
    }
  }
  const sel = pieceCourante();
  if (state.pointage && sel && state.pointage.points.length) {
    tracer(sel.camp, [[sel.lng, sel.lat], ...state.pointage.points]);
    state.pointage.points.forEach((q) => features.push({ type: 'Feature', properties: { camp: sel.camp }, geometry: { type: 'Point', coordinates: q } }));
  }
  return { type: 'FeatureCollection', features };
}

function rafraichirCarte() { const s = state.map && state.map.getSource(SOURCE_CONSIGNES); if (s) s.setData(collection()); }
export function setTheme(t) { state.theme = t; }

// ---------- panneau ----------
function dessinerOperation() {
  const pieces = listerPieces();
  const choix = [['arbitre', 'Arbitre : tout voir'], ['bleu', 'Camp bleu'], ['rouge', 'Camp rouge']];
  const vue = h('select', { onchange: (e) => { state.pointDeVue = e.target.value; majVisibilite(); } },
    ...choix.map(([v, nom]) => h('option', { value: v, selected: v === state.pointDeVue }, nom)));
  $('operation').replaceChildren(
    h('div', { class: 'camps' }, h('button', { type: 'button', onclick: lancer, class: state.lancee ? '' : 'primaire' }, state.lancee ? 'Relancer les consignes en attente' : 'Lancer l\'opération'),
      h('button', { type: 'button', onclick: revenirAuDepart }, 'Revenir au départ')),
    h('label', { class: 'champ large' }, h('span', {}, 'Point de vue'), vue),
    h('p', { class: 'note' }, state.lancee ? `Opération en cours : ${pieces.length} pièce${pieces.length > 1 ? 's' : ''}. Les consignes avancent avec l'horloge de jeu (pause et vitesse : section Temps).`
      : 'Ajoutez des consignes, puis lancez : elles s\'exécutent à l\'heure de jeu, selon les capacités de chaque pièce.'));
}

function dessinerConsignes() {
  const boite = $('consignes');
  if (!boite) return;
  const pieces = listerPieces();
  const piece = pieceCourante();
  const choixPiece = h('select', { onchange: (e) => choisirPiece(e.target.value || null) }, h('option', { value: '' }, '— choisir une pièce —'),
    ...pieces.map((p) => h('option', { value: p.id, selected: piece && p.id === piece.id }, `${p.nom} (${p.camp})`)));
  if (!piece) { boite.replaceChildren(h('label', { class: 'champ large' }, h('span', {}, 'Pièce'), choixPiece), h('p', { class: 'note' }, 'Posez une pièce sur la carte, puis sélectionnez-la pour lui donner des consignes.')); return; }

  const peutBouger = piece.mouvement.max > 0, peutTirer = piece.feu.portee_km > 0;
  const types = Object.entries(TYPES).filter(([t]) => (t === 'aller' ? peutBouger : t === 'engager' ? peutTirer : true));
  if (!types.some(([t]) => t === state.forme.type)) state.forme = { ...state.forme, type: types[0][0] };
  const f = state.forme;
  const adverses = pieces.filter((p) => p.camp !== piece.camp);
  if (f.type === 'engager' && !adverses.some((p) => p.id === f.cibleId)) state.forme = { ...state.forme, cibleId: adverses[0] ? adverses[0].id : '' };

  const typeSel = h('select', { onchange: (e) => { state.forme = { ...state.forme, type: e.target.value }; if (state.pointage) arreterPointage(false); dessinerConsignes(); } },
    ...types.map(([t, nom]) => h('option', { value: t, selected: t === state.forme.type }, nom)));
  const allureSel = h('select', { onchange: (e) => { state.forme = { ...state.forme, allure: e.target.value }; dessinerBilan(); } },
    ...Object.entries(ALLURES).map(([a, nom]) => h('option', { value: a, selected: a === state.forme.allure }, `${nom} · ${vitesse(piece, a).toString().replace('.', ',')} km/h`)));
  const lignes = [h('label', { class: 'champ large' }, h('span', {}, 'Pièce'), choixPiece), h('label', { class: 'champ large' }, h('span', {}, 'Consigne'), typeSel)];

  if (state.forme.type === 'aller') {
    const n = (state.pointage ? state.pointage.points : state.forme.points || []).length;
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel),
      state.pointage
        ? h('div', { class: 'camps' }, h('button', { type: 'button', onclick: () => arreterPointage(true) }, `Terminer (${n} point${n > 1 ? 's' : ''})`), h('button', { type: 'button', onclick: () => arreterPointage(false) }, 'Annuler'))
        : h('button', { type: 'button', onclick: demarrerPointage }, n ? `Itinéraire : ${n} point${n > 1 ? 's' : ''} (refaire)` : 'Choisir la destination sur la carte'));
  } else if (state.forme.type === 'observer') {
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Durée'),
      h('input', { type: 'text', inputmode: 'numeric', value: String(state.forme.dureeMin), oninput: (e) => { state.forme = { ...state.forme, dureeMin: Number(e.target.value.replace(',', '.')) || 0 }; dessinerBilan(); } })));
  } else {
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Cible'), h('select', { onchange: (e) => { state.forme = { ...state.forme, cibleId: e.target.value }; dessinerBilan(); } },
      ...adverses.map((p) => h('option', { value: p.id, selected: p.id === state.forme.cibleId }, `${p.nom} (${p.camp})`)))),
    h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel));
  }
  lignes.push(h('div', { id: 'o-bilan' }), h('button', { type: 'button', id: 'o-ajouter', class: 'primaire', onclick: ajouter }, 'Donner la consigne'));

  const file = fileDe(piece.id);
  const suite = file.length ? file.map((c) => h('div', { class: 'consigne' },
    h('span', {}, h('b', {}, libelle(c, pieces)), h('small', {}, STATUTS[c.statut])), h('button', { type: 'button', title: 'Retirer', onclick: () => retirer(piece.id, c.id) }, '×')))
    : [h('p', { class: 'note' }, 'Aucune consigne pour cette pièce.')];
  boite.replaceChildren(...lignes, h('h4', {}, `Consignes de ${piece.nom}`), ...suite);
  dessinerBilan();
}

// ---------- montage ----------
export function monter(map) {
  state.map = map;
  state.ordres = lire(STORAGE_ORDRES, {}); state.journal = lire(STORAGE_JOURNAL, []);
  map.on('click', (e) => { if (state.pointage) pointer(e.lngLat); });
  document.addEventListener('wg:piece', () => dessinerConsignes());
  document.addEventListener('wg:pieces', () => {
    const ids = new Set(listerPieces().map((p) => p.id));
    state.ordres = Object.fromEntries(Object.entries(state.ordres).filter(([id]) => ids.has(id)));
    dessinerConsignes(); dessinerOperation(); rafraichirCarte(); majVisibilite();
  });
  document.addEventListener('keydown', (e) => {
    if (!state.pointage) return;
    if (e.key === 'Escape') arreterPointage(false);
    else if (e.key === 'Enter') arreterPointage(true);
  });
  surTick(pas);
  dessinerOperation(); dessinerConsignes(); dessinerJournal(); rafraichirCarte();
}
