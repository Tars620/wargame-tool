import { distanceKm, formatKm, formatDuree } from './geo.js';
import { ALLURES, avancer, contacts, estPoste, position, etatLiaison, exigePoste, phraseLiaison, trajetPrevu, verifier, visiblesPour, vitesse } from './moteur.js';
import { terrain } from './terrain-carte.js';
import { PARIS, date, heure } from './fuseaux.js';
import { maintenant, surTick } from './temps.js';
import { listerPieces, pieceChoisie, choisirPiece, positionner, appliquerVisibilite, detruire, restaurer, rafraichirPortees, modifier } from './pieces.js';
import { estJoueur, role } from './role.js';
import { empiler, envoyerOrdre } from './partie.js';
import { aFeu, brouilleSur, doitRentrer, effets, enVol, enduranceRestante, estDrone, rayonVision, retourPossible } from './regles.js';
import { conditions } from './meteo.js';

export const SOURCE_CONSIGNES = 'consignes';
const STORAGE_ORDRES = 'wg.ordres.v1';
const STORAGE_JOURNAL = 'wg.journal.v1';
const JOURNAL_MAX = 300;
const JOURNAL_AFFICHE = 60;
const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };
const STATUTS = { attente: 'En attente', lance: 'À démarrer', en_cours: 'En cours', terminee: 'Terminée' };
const TYPES = { aller: 'Aller à', observer: 'Observer', engager: 'Engager (feu)', rentrer: 'Rentrer se poser' };

const state = { map: null, ordres: {}, journal: [], depart: null, pointDeVue: 'arbitre', pointage: null,
  forme: { type: 'aller', allure: 'normale', dureeMin: 10, cibleId: '' }, contactsVus: new Set(), liaisons: null, positionsEquipes: new Map(), meteo: null, theme: 'sombre' };
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
const sauver = () => { if (estJoueur()) return; ecrire(STORAGE_ORDRES, state.ordres); ecrire(STORAGE_JOURNAL, state.journal); };
const nomDe = (pieces, id) => (pieces.find((p) => p.id === id) || { nom: 'pièce retirée' }).nom;
const km = (x) => formatKm(x);

// ---------- journal des opérations ----------
/** Camps (bleu, rouge) des pièces désignées : le public naturel d'un événement qui les concerne. */
const cotes = (pieces, ...ids) => [...new Set(ids.map((id) => (pieces.find((p) => p.id === id) || {}).camp).filter(Boolean))];

/**
 * Une ligne du journal. `public` dit qui peut la lire : une liste de camps, 'all', ou [] (arbitrage seul, par défaut :
 * ce qui n'a pas de public explicite ne fuit jamais). Elle est aussi enregistrée dans la chaîne de la partie.
 */
function noter(t, texte, genre = 'info', publicVise = []) {
  state.journal = [{ t, texte, genre, visible_to: publicVise }, ...state.journal].slice(0, JOURNAL_MAX);
  sauver(); dessinerJournal();
  empiler({ texte, genre, t, visible_to: publicVise });
}

const enPartieArbitre = () => role.genre === 'arbitre';
const libellePublic = (v) => (v === 'all' ? 'tous' : Array.isArray(v) && v.length ? v.join(' et ') : 'arbitrage seul');

function dessinerJournal() {
  const liste = $('journal-ops');
  if (!liste) return;
  if (!state.journal.length) { liste.replaceChildren(h('p', { class: 'note' }, 'Aucun événement. Les départs, arrivées, contacts et tirs apparaissent ici, à l\'heure de jeu.')); return; }
  liste.replaceChildren(...state.journal.slice(0, JOURNAL_AFFICHE).map((e) => h('div', { class: `evt evt-${e.genre}` },
    h('small', {}, `${date(e.t, PARIS)} ${heure(e.t, PARIS)} Paris${enPartieArbitre() ? ` · ${libellePublic(e.visible_to)}` : ''}`), h('span', {}, e.texte))),
  h('button', { type: 'button', class: 'danger', onclick: () => { state.journal = []; sauver(); dessinerJournal(); } }, 'Effacer le journal'));
}

// ---------- consignes ----------
const pieceCourante = () => listerPieces().find((p) => p.id === pieceChoisie()) || null;
const fileDe = (id) => state.ordres[id] || [];
function majFile(id, fn) { state.ordres = { ...state.ordres, [id]: fn(fileDe(id)) }; sauver(); }

function libelle(c, pieces) {
  if (c.type === 'aller') return `Aller à ${c.points.length > 1 ? `${c.points.length} points` : 'un point'} (${km(c.distanceKm || 0)}, allure ${ALLURES[c.allure].toLowerCase()})`;
  if (c.type === 'observer') return `Observer ${c.dureeMin} min`;
  if (c.type === 'rentrer') return c.auto ? 'Rentrer se poser (retour automatique)' : 'Rentrer se poser';
  return `Engager ${nomDe(pieces, c.cibleId)}`;
}

function nouvelleConsigne(piece) {
  const f = state.forme;
  const base = { id: newId(), type: f.type, allure: f.allure, statut: 'lance' };
  if (f.type === 'aller') return { ...base, points: state.pointage ? state.pointage.points : (f.points || []) };
  if (f.type === 'observer') return { ...base, dureeMin: Number(f.dureeMin) };
  if (f.type === 'rentrer') return base;
  return { ...base, cibleId: f.cibleId };
}

async function bilan(piece, consigne, pieces) {
  let meteo = null;
  if (piece.meteo_max) { try { meteo = await conditions(piece.lng, piece.lat, maintenant()); } catch { meteo = null; } }
  const trajet = trajetPrevu(piece, pieces, consigne);
  if (trajet && !estDrone(piece)) { try { await terrain.assurerChemin(trajet); } catch { /* le terrain manquant est signalé par verifier */ } }
  return verifier(piece, consigne, { pieces, meteo, terrain });
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
  if (estJoueur()) { await transmettre(piece, c); return; }
  assurerDepart();
  majFile(piece.id, (file) => [...file, c]);
  if (state.pointage) arreterPointage(false);
  state.forme = { ...state.forme, points: [] };
  dessinerConsignes(); rafraichirCarte();
}

function retirer(pieceId, id) {
  if (estJoueur()) { envoyerOrdre({ type: 'annuler', pieceId, consigneId: id }).then(() => etatOrdre('Annulation transmise à l\'arbitre.')).catch((e) => etatOrdre(e.message, true)); return; }
  majFile(pieceId, (file) => file.filter((c) => c.id !== id)); dessinerConsignes(); rafraichirCarte();
}

// ---------- ordres d'un joueur ----------
/** Retour affiché sous le formulaire : l'ordre est transmis, puis accepté ou refusé par l'arbitre (le motif revient avec la vue). */
function etatOrdre(texte, erreur = false) { const z = $('o-retour'); if (z) z.replaceChildren(h('p', { class: erreur ? 'err' : 'note' }, texte)); }

async function transmettre(piece, c) {
  const consigne = { type: c.type, allure: c.allure, ...(c.type === 'aller' ? { points: c.points } : {}), ...(c.type === 'observer' ? { dureeMin: c.dureeMin } : {}), ...(c.type === 'engager' ? { cibleId: c.cibleId } : {}) };
  try { await envoyerOrdre({ type: 'consigne', pieceId: piece.id, consigne }); etatOrdre('Ordre transmis à l\'arbitre.'); } catch (e) { etatOrdre(e.message, true); return; }
  if (state.pointage) arreterPointage(false);
  state.forme = { ...state.forme, points: [] };
  dessinerConsignes();
}

/**
 * Arbitre : exécute l'ordre d'un joueur après l'avoir revérifié avec les VRAIES données (capacités, endurance, liaison, détection de la cible).
 * Rend { ok, message } : le joueur reçoit ce message.
 */
export async function traiterCommande(cmd) {
  const pieces = listerPieces();
  const piece = pieces.find((p) => p.id === cmd.corps.pieceId);
  if (!piece || piece.camp !== cmd.side) return { ok: false, message: 'Pièce introuvable.' };
  if (piece.detruit) return { ok: false, message: 'Cette pièce est détruite.' };
  if (cmd.corps.type === 'annuler') {
    if (!fileDe(piece.id).some((c) => c.id === cmd.corps.consigneId)) return { ok: false, message: 'Cette consigne n\'existe plus.' };
    retirer(piece.id, cmd.corps.consigneId);
    noter(maintenant(), `${cmd.auteur} annule une consigne de ${piece.nom}.`, 'op', [cmd.side]);
    return { ok: true, message: 'Consigne annulée.' };
  }
  const c = { id: newId(), statut: 'lance', ...cmd.corps.consigne };
  if (c.type === 'engager' && !visiblesPour(cmd.side, pieces, terrain).has(c.cibleId)) return { ok: false, message: 'Cette cible n\'est pas détectée par votre camp.' };
  const r = await bilan(piece, c, pieces);
  if (!r.ok) return { ok: false, message: r.erreurs.join(' ') };
  ajouterConsignes([{ ref: piece.id, consigne: c.type === 'aller' ? { ...c, distanceKm: r.distanceKm } : c }]);
  noter(maintenant(), `${cmd.auteur} : ${piece.nom} reçoit « ${libelle(c, pieces)} ».`, 'op', [cmd.side]);
  return { ok: true, message: r.avertissements.length ? `Ordre accepté. ${r.avertissements.join(' ')}` : 'Ordre accepté.' };
}

/** Vue d'un joueur : consignes et journal reçus du serveur. */
export function remplacerOrdres(ordres) {
  const cle = JSON.stringify(ordres);
  if (cle === state.cleVue) return;
  state.cleVue = cle; state.ordres = ordres; listeVue = null;
  dessinerListe(); rafraichirCarte();
}
export function remplacerJournal(entrees) {
  const connus = new Set(state.journal.map((e) => `${e.t}|${e.texte}`));
  const neuves = entrees.filter((e) => !connus.has(`${e.t}|${e.texte}`));
  if (!neuves.length) return;
  state.journal = [...neuves.reverse(), ...state.journal].slice(0, JOURNAL_MAX);
  dessinerJournal();
}
/** Résultat d'un ordre donné par ce joueur (accepté ou refusé par l'arbitre), à afficher sous le formulaire. */
export function resultatsOrdres(commandes) {
  const dernier = commandes.find((c) => c.statut !== 'attente');
  if (dernier) etatOrdre(dernier.statut === 'traitee' ? `Accepté : ${dernier.reponse || 'ordre exécuté'}` : `Refusé : ${dernier.reponse || 'ordre non exécutable'}`, dernier.statut === 'refusee');
}

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
/** Garde les positions d'avant la première consigne, pour pouvoir y revenir. */
function assurerDepart() {
  if (!state.depart) state.depart = Object.fromEntries(listerPieces().map((p) => [p.id, [p.lng, p.lat]]));
}

/** Consignes proposées par l'assistant, déjà vérifiées : { ref: id de pièce, consigne }. Elles démarrent avec l'horloge de jeu. */
export function ajouterConsignes(cibles) {
  assurerDepart();
  for (const { ref, consigne } of cibles) majFile(ref, (file) => [...file, { ...consigne, id: newId(), statut: 'lance' }]);
  dessinerConsignes(); rafraichirCarte();
}

export const libelleConsigne = (c) => libelle(c, listerPieces());
export const etatOrdres = () => state.ordres;
export function noterOperation(texte) { noter(maintenant(), texte, 'op'); }

function revenirAuDepart() {
  if (state.depart) for (const [id, pos] of Object.entries(state.depart)) positionner(id, pos);
  for (const id of Object.keys(state.ordres)) {
    state.ordres = { ...state.ordres, [id]: fileDe(id).map((c) => ({ ...c, statut: 'lance', etape: 0, ecouleMin: 0 })) };
  }
  for (const p of listerPieces()) if (p.detruit) restaurer(p.id);
  state.depart = null; state.contactsVus = new Set(); sauver();
  noter(maintenant(), 'Retour aux positions de départ : consignes remises à zéro, pièces détruites rétablies.', 'op');
  dessinerOperation(); dessinerConsignes(); rafraichirCarte(); majVisibilite();
}

const metres = (km) => `${Math.round(km * 1000)} m`;

/** Journalise un événement du moteur et applique ses effets : destructions, atterrissage. */
function evenement(t, e, pieces) {
  const nom = nomDe(pieces, e.pieceId);
  if (e.type === 'arrivee') noter(t, `${nom} est arrivé à destination.`, 'info', cotes(pieces, e.pieceId));
  else if (e.type === 'fin_observation') noter(t, `${nom} termine son observation.`, 'info', cotes(pieces, e.pieceId));
  else if (e.type === 'cible_perdue') noter(t, `${nom} : cible introuvable ou déjà détruite, engagement annulé.`, 'alerte', cotes(pieces, e.pieceId));
  else if (e.type === 'bloque') noter(t, `${nom} s'arrête : l'eau lui barre la route.`, 'alerte', cotes(pieces, e.pieceId));
  else if (e.type === 'sans_equipe') noter(t, `${nom} : plus d'équipe de pilotes où se poser.`, 'alerte', cotes(pieces, e.pieceId));
  else if (e.type === 'atterri') {
    const p = pieces.find((q) => q.id === e.pieceId);
    modifier(e.pieceId, { etat: 'sol', endurance_restante_min: p ? p.endurance_min : undefined });
    noter(t, `${nom} se pose auprès de ${nomDe(pieces, e.equipeId)} : endurance rechargée.`, 'info', cotes(pieces, e.pieceId));
  } else if (e.type === 'tir' || e.type === 'frappe' || e.type === 'tir_zone') {
    const cible = nomDe(pieces, e.cibleId);
    if (e.type === 'tir') noter(t, `TIR : ${nom} engage ${cible} à ${metres(e.distanceKm)}.`, 'tir', cotes(pieces, e.pieceId, e.cibleId));
    else if (e.type === 'frappe') noter(t, `FRAPPE : ${nom} explose sur ${cible}.`, 'tir', cotes(pieces, e.pieceId, e.cibleId));
    else noter(t, `TIR DE ZONE : ${nom} tire sur ${cible} (impact à ${metres(distanceKm(e.impact, position(pieces.find((q) => q.id === e.cibleId) || { lng: e.impact[0], lat: e.impact[1] })))} de la cible, rayon ${Math.round(e.rayonM)} m).`, 'tir', cotes(pieces, e.pieceId, e.cibleId));
    const touches = effets(e, pieces);
    for (const { id, cause } of touches) { detruire(id, cause); noter(t, `${nomDe(pieces, id)} est détruit.`, 'tir', cotes(pieces, e.pieceId, id)); }
    if (!touches.length) noter(t, 'Aucune pièce touchée.', 'info', cotes(pieces, e.pieceId));
  }
}

/** Les drones au sol suivent leur équipe de pilotes quand elle bouge (déplacement par consigne ou à la main). */
function suivreEquipes(pieces) {
  const nouvelles = new Map(pieces.filter((q) => estPoste(q)).map((q) => [q.id, [q.lng, q.lat]]));
  for (const [id, pos] of nouvelles) {
    const ancien = state.positionsEquipes.get(id);
    if (!ancien || (ancien[0] === pos[0] && ancien[1] === pos[1])) continue;
    for (const d of pieces) if (d.poste === id && estDrone(d) && !enVol(d) && !d.detruit) positionner(d.id, [d.lng + pos[0] - ancien[0], d.lat + pos[1] - ancien[1]]);
  }
  state.positionsEquipes = nouvelles;
}

/** Endurance des drones en vol : décompte, retour automatique quand il ne reste que le temps de rentrer, perte si elle s'épuise. */
function suivreVol(t, dtMin) {
  const pieces = listerPieces();
  let change = false;
  for (const d of pieces) {
    if (!enVol(d) || d.detruit) continue;
    const reste = enduranceRestante(d) - dtMin;
    if (reste <= 0) { modifier(d.id, { endurance_restante_min: 0 }); detruire(d.id, 'endurance'); noter(t, `${d.nom} : endurance épuisée, drone perdu.`, 'alerte', [d.camp]); continue; }
    modifier(d.id, { endurance_restante_min: reste });
    const equipe = pieces.find((q) => q.id === d.poste && estPoste(q));
    const file = fileDe(d.id);
    const actif = file.find((c) => c.statut === 'lance' || c.statut === 'en_cours');
    if (retourPossible(d) && equipe && !equipe.detruit && !(actif && actif.type === 'rentrer') && doitRentrer({ ...d, endurance_restante_min: reste }, equipe, vitesse(d, 'normale'))) {
      state.ordres = { ...state.ordres, [d.id]: [{ id: newId(), type: 'rentrer', allure: 'normale', statut: 'lance', auto: true }, ...file.map((c) => (c.statut === 'en_cours' ? { ...c, statut: 'lance' } : c))] };
      noter(t, `${d.nom} : il ne reste que le temps de rentrer (${Math.round(reste)} min), retour automatique.`, 'alerte', [d.camp]);
      change = true;
    }
  }
  return change;
}

/** Un drone en vol qui entre dans la zone d'un brouilleur ennemi est perdu (sauf le drone filoguidé). */
function suivreBrouillage(t) {
  const pieces = listerPieces();
  for (const d of pieces) {
    const brouilleur = brouilleSur(d, pieces);
    if (brouilleur) { detruire(d.id, 'brouillage'); noter(t, `BROUILLAGE : ${d.nom} entre dans la zone de ${brouilleur.nom}, liaison perdue : drone détruit.`, 'alerte', [...new Set([d.camp, brouilleur.camp])]); }
  }
}

/** Charge le terrain autour des pièces qui observent (leur vision, 1,2 km au moins) : ce que le moteur lit ne doit jamais attendre le réseau. */
function preparerTerrain(pieces) {
  if (!terrain.actif) return;
  const points = pieces.filter((p) => !p.detruit).map((p) => [p.lng, p.lat]);
  const rayon = Math.max(1.2, ...pieces.map((p) => rayonVision(p.vision) + 0.2));
  terrain.assurerPoints(points, rayon).catch(() => {});
}

function pas(t, dtMs) {
  if (estJoueur()) return; // la simulation tourne chez l'arbitre ; un joueur reçoit son état
  const dtMin = dtMs / 60000;
  const pieces = listerPieces();
  preparerTerrain(pieces);
  suivreEquipes(pieces);
  let change = false;
  for (const piece of pieces) {
    if (piece.detruit) continue;
    const file = fileDe(piece.id);
    const i = file.findIndex((c) => c.statut === 'lance' || c.statut === 'en_cours');
    if (i < 0) continue;
    if (exigePoste(piece) && file[i].type !== 'rentrer' && !etatLiaison(piece, pieces).ok) continue; // liaison coupée : rien ne s'exécute tant qu'elle ne revient pas
    let c = file[i];
    let pc = piece;
    if (c.statut === 'lance') {
      c = { ...c, statut: 'en_cours', debutMs: t, depart: [piece.lng, piece.lat] };
      noter(t, `${piece.nom} : début « ${libelle(c, pieces)} ».`, 'info', [piece.camp]);
      if (estDrone(piece) && !enVol(piece)) { modifier(piece.id, { etat: 'vol' }); pc = { ...piece, etat: 'vol' }; noter(t, `${piece.nom} décolle.`, 'info', [piece.camp]); }
    }
    const r = avancer(pc, c, dtMin, pieces, String(Math.floor(t / 1000)), terrain);
    if (exigePoste(piece) && r.position && c.type !== 'rentrer') { // l'équipe a pu bouger : jamais plus loin que la portée du drone
      const l = etatLiaison({ ...piece, lng: r.position[0], lat: r.position[1] }, pieces);
      if (!l.ok && l.raison === 'hors_portee') {
        noter(t, `LIAISON : ${piece.nom} s'arrête, la suite de « ${libelle(c, pieces)} » sortirait de la portée de son équipe (${l.poste.nom}).`, 'alerte', [piece.camp]);
        state.ordres = { ...state.ordres, [piece.id]: file.map((x, j) => (j === i ? { ...c, statut: 'terminee', finMs: t } : x)) };
        change = true; continue;
      }
    }
    positionner(piece.id, r.position, r.termine && c.type !== 'observer' && c.type !== 'rentrer' ? c.depart : null);
    for (const e of r.evenements) evenement(t, e, pieces);
    const suivi = r.termine ? { ...r.consigne, statut: 'terminee', finMs: t } : { ...r.consigne, statut: 'en_cours' };
    state.ordres = { ...state.ordres, [piece.id]: fileDe(piece.id).map((x, j) => (j === i ? suivi : x)) };
    change = true;
  }
  if (suivreVol(t, dtMin)) change = true;
  suivreBrouillage(t);
  if (change) { sauver(); suivreContacts(t); dessinerListe(); rafraichirCarte(); }
  suivreLiaisons(t);
  if (change) rafraichirPortees();
  majVisibilite();
}

/** Journal des liaisons : une ligne quand une liaison se coupe, une quand elle revient (la situation de départ n'est pas rapportée). */
function suivreLiaisons(t) {
  const pieces = listerPieces();
  const coupees = new Set();
  for (const p of pieces) if (exigePoste(p) && !p.detruit && !etatLiaison(p, pieces).ok) coupees.add(p.id);
  if (state.liaisons) {
    for (const p of pieces) {
      if (coupees.has(p.id) && !state.liaisons.has(p.id)) noter(t, `LIAISON COUPÉE : ${p.nom} ${phraseLiaison(etatLiaison(p, pieces))}.`, 'alerte', [p.camp]);
      else if (!coupees.has(p.id) && state.liaisons.has(p.id) && exigePoste(p) && !p.detruit) noter(t, `Liaison rétablie : ${p.nom} avec ${etatLiaison(p, pieces).poste.nom}.`, 'info', [p.camp]);
    }
    if (coupees.size !== state.liaisons.size || [...coupees].some((id) => !state.liaisons.has(id))) rafraichirPortees();
  }
  state.liaisons = coupees;
}

function suivreContacts(t) {
  const pieces = listerPieces();
  const maintenantVus = new Set(contacts(pieces, terrain).map((c) => `${c.observateurId}>${c.cibleId}`));
  for (const cle of maintenantVus) if (!state.contactsVus.has(cle)) {
    const [o, c] = cle.split('>');
    const d = distanceKm([pieces.find((p) => p.id === o).lng, pieces.find((p) => p.id === o).lat], [pieces.find((p) => p.id === c).lng, pieces.find((p) => p.id === c).lat]);
    noter(t, `CONTACT : ${nomDe(pieces, o)} repère ${nomDe(pieces, c)} à ${km(d)}.`, 'contact', cotes(pieces, o)); // seul l'observateur apprend qu'il a repéré
  }
  state.contactsVus = maintenantVus;
}

function majVisibilite() {
  if (state.pointDeVue === 'arbitre') { appliquerVisibilite(null); return; }
  appliquerVisibilite(visiblesPour(state.pointDeVue, listerPieces(), terrain));
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
  const choix = [['arbitre', 'Arbitre : tout voir'], ['bleu', 'Camp bleu'], ['rouge', 'Camp rouge']];
  const vue = h('select', { onchange: (e) => { state.pointDeVue = e.target.value; majVisibilite(); } },
    ...choix.map(([v, nom]) => h('option', { value: v, selected: v === state.pointDeVue }, nom)));
  $('operation').replaceChildren(
    h('label', { class: 'champ large' }, h('span', {}, 'Point de vue'), vue),
    h('button', { type: 'button', onclick: revenirAuDepart }, 'Revenir au départ'),
    h('p', { class: 'note' }, 'Les consignes s\'exécutent avec l\'horloge de jeu (en haut : pause et vitesse). « Revenir au départ » replace les pièces comme avant la première consigne.'));
}

function dessinerConsignes() {
  const boite = $('consignes');
  if (!boite) return;
  const pieces = listerPieces();
  const piece = pieceCourante();
  const commandables = estJoueur() ? pieces.filter((p) => p.camp === role.camp && !p.detruit) : pieces;
  const choixPiece = h('select', { onchange: (e) => choisirPiece(e.target.value || null) }, h('option', { value: '' }, '— choisir une pièce —'),
    ...commandables.map((p) => h('option', { value: p.id, selected: piece && p.id === piece.id }, `${p.nom} (${p.camp})`)));
  if (!piece || (estJoueur() && piece.camp !== role.camp)) { boite.replaceChildren(h('label', { class: 'champ large' }, h('span', {}, 'Pièce'), choixPiece), h('p', { class: 'note' }, 'Posez une pièce sur la carte, puis sélectionnez-la pour lui donner des consignes.')); return; }

  const peutBouger = piece.mouvement.max > 0, peutTirer = aFeu(piece);
  const types = Object.entries(TYPES).filter(([t]) => (t === 'aller' ? peutBouger : t === 'engager' ? peutTirer : t === 'rentrer' ? retourPossible(piece) : true));
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
  } else if (state.forme.type === 'rentrer') {
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel));
  } else if (state.forme.type === 'observer') {
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Durée'),
      h('input', { type: 'text', inputmode: 'numeric', value: String(state.forme.dureeMin), oninput: (e) => { state.forme = { ...state.forme, dureeMin: Number(e.target.value.replace(',', '.')) || 0 }; dessinerBilan(); } })));
  } else {
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Cible'), h('select', { onchange: (e) => { state.forme = { ...state.forme, cibleId: e.target.value }; dessinerBilan(); } },
      ...adverses.map((p) => h('option', { value: p.id, selected: p.id === state.forme.cibleId }, `${p.nom} (${p.camp})`)))),
    h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel));
  }
  lignes.push(h('div', { id: 'o-bilan' }), h('button', { type: 'button', id: 'o-ajouter', class: 'primaire', onclick: ajouter }, estJoueur() ? 'Transmettre l\'ordre' : 'Donner la consigne'), h('div', { id: 'o-retour' }));

  boite.replaceChildren(...lignes, h('div', { id: 'o-liste' }));
  listeVue = null;
  dessinerListe();
  dessinerBilan();
}

// La suite des consignes change à chaque pas d'horloge ; le formulaire au-dessus, jamais : sinon une liste déroulante ouverte se refermerait sous la souris.
let listeVue = null;
function dessinerListe() {
  const zone = $('o-liste');
  const piece = pieceCourante();
  if (!zone || !piece) return;
  const pieces = listerPieces();
  const file = fileDe(piece.id);
  const lignes = file.map((c) => ({ id: c.id, texte: libelle(c, pieces), statut: STATUTS[c.statut] }));
  const cle = JSON.stringify([piece.id, piece.nom, lignes]);
  if (cle === listeVue) return; // rien n'a changé : on ne touche pas à la page (un clic sur « × » ne doit pas tomber dans le vide)
  listeVue = cle;
  const suite = lignes.length ? lignes.map((l) => h('div', { class: 'consigne' },
    h('span', {}, h('b', {}, l.texte), h('small', {}, l.statut)), h('button', { type: 'button', title: 'Retirer', onclick: () => retirer(piece.id, l.id) }, '×')))
    : [h('p', { class: 'note' }, 'Aucune consigne pour cette pièce.')];
  zone.replaceChildren(h('h4', {}, `Consignes de ${piece.nom}`), ...suite);
}

/** Reconstruit le formulaire, sauf si l'arbitre est en train de s'en servir (champ actif dans le panneau). */
function dessinerConsignesSiLibre() {
  const actif = document.activeElement;
  if (actif && $('consignes') && $('consignes').contains(actif) && ['SELECT', 'INPUT'].includes(actif.tagName)) { dessinerListe(); return; }
  dessinerConsignes();
}

// ---------- montage ----------
export function monter(map) {
  state.map = map;
  state.ordres = estJoueur() ? {} : Object.fromEntries(Object.entries(lire(STORAGE_ORDRES, {})).map(([id, file]) => [id, file.map((c) => (c.statut === 'attente' ? { ...c, statut: 'lance' } : c))]));
  state.journal = estJoueur() ? [] : lire(STORAGE_JOURNAL, []);
  map.on('click', (e) => { if (state.pointage) pointer(e.lngLat); });
  document.addEventListener('wg:piece', () => dessinerConsignes());
  document.addEventListener('wg:cascade', (e) => {
    if (estJoueur()) return;
    const pieces = listerPieces(), poste = pieces.find((p) => p.id === e.detail.posteId);
    const noms = e.detail.droneIds.map((id) => nomDe(pieces, id)).join(', ');
    noter(maintenant(), `LIAISON PERDUE : ${poste ? poste.nom : 'l\'équipe de pilotes'} est détruite, ${e.detail.droneIds.length > 1 ? 'ses drones sont détruits' : 'son drone est détruit'} : ${noms}.`, 'alerte', poste ? [poste.camp] : undefined);
    suivreContacts(maintenant()); majVisibilite(); rafraichirCarte();
  });
  document.addEventListener('wg:terrain', () => { if (estJoueur()) return; suivreContacts(maintenant()); majVisibilite(); dessinerBilan(); });
  document.addEventListener('wg:pieces', () => {
    const ids = new Set(listerPieces().map((p) => p.id));
    state.ordres = Object.fromEntries(Object.entries(state.ordres).filter(([id]) => ids.has(id)));
    dessinerConsignesSiLibre(); dessinerOperation(); rafraichirCarte(); majVisibilite();
  });
  document.addEventListener('keydown', (e) => {
    if (!state.pointage) return;
    if (e.key === 'Escape') arreterPointage(false);
    else if (e.key === 'Enter') arreterPointage(true);
  });
  surTick(pas);
  dessinerOperation(); dessinerConsignes(); dessinerJournal(); rafraichirCarte();
}
