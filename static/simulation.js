// Simulation : fait avancer les consignes avec l'horloge de jeu, applique les événements du moteur (tirs, destructions, endurance, brouillage, liaisons)
// et tient à jour les contacts et la visibilité. Tourne chez l'arbitre seulement.
import { distanceKm } from './geo.js';
import { avancer, contacts, estPoste, position, etatLiaison, exigePoste, phraseLiaison, visiblesPour, vitesse } from './moteur.js';
import { terrain } from './terrain-carte.js';
import { surTick } from './temps.js';
import { listerPieces, positionner, appliquerVisibilite, detruire, rafraichirPortees, modifier } from './pieces.js';
import { estJoueur } from './role.js';
import { brouilleSur, doitRentrer, effets, enVol, enduranceRestante, estDrone, rayonVision, retourPossible } from './regles.js';
import { cotes, fileDe, km, libelle, newId, nomDe, sauver, state } from './ordres-etat.js';
import { noter } from './journal.js';
import { rafraichirCarte } from './ordres-carte.js';

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

export function pas(t, dtMs) {
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
  if (change) { sauver(); suivreContacts(t); state.redessinerListe(); rafraichirCarte(); }
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

export function suivreContacts(t) {
  const pieces = listerPieces();
  const maintenantVus = new Set(contacts(pieces, terrain).map((c) => `${c.observateurId}>${c.cibleId}`));
  for (const cle of maintenantVus) if (!state.contactsVus.has(cle)) {
    const [o, c] = cle.split('>');
    const d = distanceKm([pieces.find((p) => p.id === o).lng, pieces.find((p) => p.id === o).lat], [pieces.find((p) => p.id === c).lng, pieces.find((p) => p.id === c).lat]);
    noter(t, `CONTACT : ${nomDe(pieces, o)} repère ${nomDe(pieces, c)} à ${km(d)}.`, 'contact', cotes(pieces, o)); // seul l'observateur apprend qu'il a repéré
  }
  state.contactsVus = maintenantVus;
}

export function majVisibilite() {
  if (state.pointDeVue === 'arbitre') { appliquerVisibilite(null); return; }
  appliquerVisibilite(visiblesPour(state.pointDeVue, listerPieces(), terrain));
}

/** Branche la simulation sur l'horloge de jeu. */
export const monterSimulation = () => surTick(pas);
