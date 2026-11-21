// Moteur des consignes : fonctions pures (aucun accès au navigateur), donc testables avec node.
// Une pièce : { id, camp, lng, lat, mouvement:{min,max}, feu:{portee_km,puissance}, vision:{rayon_km}, meteo_max?:{vent_kmh} }
// Une consigne : { type: 'aller'|'observer'|'engager', ... }
import { distanceKm, longueurKm, pointVers } from './geo.js';

export const ALLURES = { prudente: 'Prudente', normale: 'Normale', maximale: 'Maximale' };
const MARGE_PORTEE = 0.999; // on s'arrête juste à l'intérieur de la portée de feu

export const position = (p) => [p.lng, p.lat];

// ---------- liaison avec un poste de commandement ----------
// Un modèle « poste » porte commande: { portee_km }. Un modèle « drone » porte liaison: true : il doit être rattaché à un poste de son camp
// et rester dans la portée de ce poste. Un poste peut avoir autant de drones qu'on veut ; un drone n'a qu'un poste.
export const LIAISON_KM = 30;
export const exigePoste = (p) => Boolean(p.liaison);
export const estPoste = (p) => Boolean(p.commande);
export const porteeDuPoste = (poste) => (poste && poste.commande && poste.commande.portee_km > 0 ? poste.commande.portee_km : LIAISON_KM);
const km1 = (x) => x.toFixed(1).replace('.', ',');

/** État de la liaison d'une pièce : { requise, ok, raison: null|'aucun'|'detruit'|'camp'|'hors_portee', poste, distanceKm, porteeKm }. */
export function etatLiaison(piece, pieces) {
  if (!exigePoste(piece)) return { requise: false, ok: true, raison: null };
  const poste = piece.poste ? pieces.find((q) => q.id === piece.poste && estPoste(q)) || null : null;
  if (!poste) return { requise: true, ok: false, raison: 'aucun', poste: null, porteeKm: LIAISON_KM };
  const porteeKm = porteeDuPoste(poste);
  if (poste.detruit) return { requise: true, ok: false, raison: 'detruit', poste, porteeKm };
  if (poste.camp !== piece.camp) return { requise: true, ok: false, raison: 'camp', poste, porteeKm };
  const distance = distanceKm(position(piece), position(poste));
  const ok = distance <= porteeKm + 1e-9;
  return { requise: true, ok, raison: ok ? null : 'hors_portee', poste, distanceKm: distance, porteeKm };
}

/** Phrase qui dit pourquoi une liaison est coupée (null si elle est établie). */
export function phraseLiaison(l) {
  if (!l.requise || l.ok) return null;
  if (l.raison === 'detruit') return `son poste de commandement (${l.poste.nom}) est détruit`;
  if (l.raison === 'camp') return `son poste de commandement (${l.poste.nom}) est d'un autre camp`;
  if (l.raison === 'hors_portee') return `est à ${km1(l.distanceKm)} km de son poste de commandement (${l.poste.nom}), ${km1(l.porteeKm)} km au plus`;
  return `n'est rattaché à aucun poste de commandement`;
}

/**
 * Rattachements à poser : pour chaque pièce qui exige un poste et n'en a pas de valide, le poste vivant de son camp le plus proche
 * dont la portée la couvre. Un poste détruit n'est pas remplacé d'office : c'est une décision de l'arbitre. Rend { idPièce: idPoste }.
 */
export function lierAuto(pieces) {
  const liens = {};
  for (const p of pieces) {
    if (!exigePoste(p) || p.detruit) continue;
    const actuel = etatLiaison(p, pieces);
    if (actuel.poste && actuel.poste.camp === p.camp) continue; // lien existant (même coupé) : on ne le défait pas
    const choix = pieces.filter((q) => estPoste(q) && !q.detruit && q.camp === p.camp)
      .map((q) => ({ q, d: distanceKm(position(p), position(q)) })).filter(({ q, d }) => d <= porteeDuPoste(q)).sort((a, b) => a.d - b.d || (a.q.id < b.q.id ? -1 : 1));
    if (choix.length) liens[p.id] = choix[0].q.id;
  }
  return liens;
}

/** Erreurs de liaison d'une consigne : le drone doit être relié, et tout ce qu'il va parcourir doit rester dans la portée de son poste. */
function erreursLiaison(piece, pieces, consigne) {
  const l = etatLiaison(piece, pieces);
  if (!l.requise) return [];
  const raison = phraseLiaison(l);
  if (raison) return [`Ce drone ${raison} : il ne peut recevoir aucune consigne.`];
  const hors = (pt) => distanceKm(pt, position(l.poste));
  if (consigne.type === 'aller' && consigne.points) {
    const loin = consigne.points.find((pt) => hors(pt) > l.porteeKm + 1e-9);
    if (loin) return [`La destination est à ${km1(hors(loin))} km de son poste de commandement (${km1(l.porteeKm)} km au plus).`];
  }
  if (consigne.type === 'engager') {
    const cible = pieces.find((q) => q.id === consigne.cibleId);
    if (cible && piece.feu.portee_km > 0) {
      const d = distanceKm(position(piece), position(cible));
      const arret = d > piece.feu.portee_km ? pointVers(position(piece), position(cible), d - piece.feu.portee_km * MARGE_PORTEE) : position(piece);
      if (hors(arret) > l.porteeKm + 1e-9) return [`Pour tirer sur cette cible, le drone devrait s'éloigner à ${km1(hors(arret))} km de son poste de commandement (${km1(l.porteeKm)} km au plus).`];
    }
  }
  return [];
}


/** Vitesse retenue (km/h) selon l'allure : minimale, moyenne ou maximale de la pièce. */
export function vitesse(piece, allure = 'normale') {
  const { min, max } = piece.mouvement;
  if (allure === 'prudente') return min;
  if (allure === 'maximale') return max;
  return (min + max) / 2;
}

const minutes = (km, kmh) => (kmh > 0 ? (km / kmh) * 60 : Infinity);

/**
 * Une consigne est-elle compatible avec les capacités de la pièce ?
 * Rend { ok, erreurs, avertissements, distanceKm, dureeMin }. Les erreurs interdisent la consigne,
 * les avertissements la laissent passer (météo, délais).
 */
export function verifier(piece, consigne, { pieces = [], meteo = null } = {}) {
  const erreurs = [];
  const avertissements = [];
  let distance = 0;
  let duree = 0;
  const v = vitesse(piece, consigne.allure);

  if (consigne.type === 'aller') {
    if (!(v > 0)) erreurs.push('Cette pièce ne peut pas se déplacer.');
    if (!consigne.points || !consigne.points.length) erreurs.push('Aucune destination.');
    else { distance = longueurKm([position(piece), ...consigne.points]); duree = minutes(distance, v); }
  } else if (consigne.type === 'observer') {
    duree = Number(consigne.dureeMin) || 0;
    if (!(duree > 0)) erreurs.push("Indiquez une durée d'observation.");
    if (!(piece.vision.rayon_km > 0)) avertissements.push("Cette pièce n'a aucune vision : l'observation ne servira à rien.");
  } else if (consigne.type === 'engager') {
    const cible = pieces.find((p) => p.id === consigne.cibleId);
    if (!(piece.feu.portee_km > 0)) erreurs.push("Cette pièce n'a aucun feu.");
    if (!cible) erreurs.push('Choisissez une cible.');
    else if (cible.detruit) erreurs.push('La cible est déjà détruite.');
    else if (cible.camp === piece.camp) erreurs.push('La cible est du même camp.');
    else {
      distance = distanceKm(position(piece), position(cible));
      const aRejoindre = Math.max(distance - piece.feu.portee_km, 0);
      if (aRejoindre > 0 && !(v > 0)) erreurs.push('Cible hors de portée et pièce immobile.');
      else duree = minutes(aRejoindre, v);
      if (aRejoindre > 0) avertissements.push(`Cible hors de portée (${distance.toFixed(1).replace('.', ',')} km pour ${piece.feu.portee_km} km) : la pièce devra d'abord s'approcher.`);
    }
  } else erreurs.push('Consigne inconnue.');

  if (!erreurs.length) erreurs.push(...erreursLiaison(piece, pieces, consigne));
  if (estPoste(piece) && consigne.type === 'aller' && consigne.points && consigne.points.length) {
    const but = consigne.points[consigne.points.length - 1];
    const perdus = pieces.filter((q) => q.poste === piece.id && exigePoste(q) && !q.detruit && distanceKm(position(q), but) > porteeDuPoste(piece) + 1e-9);
    if (perdus.length) avertissements.push(`${perdus.length} drone${perdus.length > 1 ? 's' : ''} rattaché${perdus.length > 1 ? 's' : ''} à ce poste ser${perdus.length > 1 ? 'ont' : 'a'} hors de portée à l'arrivée : liaison perdue.`);
  }

  const vent = meteo && meteo.vent_kmh;
  if (piece.meteo_max && piece.meteo_max.vent_kmh && vent > piece.meteo_max.vent_kmh) {
    avertissements.push(`Vent prévu ${Math.round(vent)} km/h, au-dessus de la limite de cette pièce (${piece.meteo_max.vent_kmh} km/h).`);
  }
  return { ok: erreurs.length === 0, erreurs, avertissements, distanceKm: distance, dureeMin: duree };
}

/**
 * Fait avancer une pièce de `dtMin` minutes de jeu selon sa consigne active.
 * Ne modifie rien : rend { position, consigne (mise à jour), termine, evenements }.
 */
export function avancer(piece, consigne, dtMin, pieces = []) {
  const evenements = [];
  const v = vitesse(piece, consigne.allure);
  let pos = position(piece);

  if (consigne.type === 'aller') {
    let reste = (v * dtMin) / 60;
    let etape = consigne.etape || 0;
    while (reste > 0 && etape < consigne.points.length) {
      const but = consigne.points[etape];
      const d = distanceKm(pos, but);
      if (reste >= d) { pos = [but[0], but[1]]; reste -= d; etape += 1; } else { pos = pointVers(pos, but, reste); reste = 0; }
    }
    const termine = etape >= consigne.points.length;
    if (termine) evenements.push({ type: 'arrivee', pieceId: piece.id, position: pos });
    return { position: pos, consigne: { ...consigne, etape }, termine, evenements };
  }

  if (consigne.type === 'observer') {
    const ecoule = (consigne.ecouleMin || 0) + dtMin;
    const termine = ecoule >= consigne.dureeMin;
    if (termine) evenements.push({ type: 'fin_observation', pieceId: piece.id });
    return { position: pos, consigne: { ...consigne, ecouleMin: ecoule }, termine, evenements };
  }

  // engager : s'approcher jusqu'à la portée, puis tirer (le résultat du tir est laissé à l'arbitre)
  const cible = pieces.find((p) => p.id === consigne.cibleId);
  if (!cible || cible.detruit) { evenements.push({ type: 'cible_perdue', pieceId: piece.id, cibleId: consigne.cibleId }); return { position: pos, consigne, termine: true, evenements }; }
  const d = distanceKm(pos, position(cible));
  if (d <= piece.feu.portee_km) {
    evenements.push({ type: 'tir', pieceId: piece.id, cibleId: cible.id, distanceKm: d, puissance: piece.feu.puissance, detruit: consigne.detruit === true });
    return { position: pos, consigne, termine: true, evenements };
  }
  const avance = Math.min((v * dtMin) / 60, d - piece.feu.portee_km * MARGE_PORTEE);
  return { position: pointVers(pos, position(cible), avance), consigne, termine: false, evenements };
}

/** Contacts : pour chaque pièce, les pièces adverses comprises dans son rayon de vision. */
export function contacts(pieces) {
  const trouves = [];
  for (const obs of pieces) {
    if (obs.detruit || !(obs.vision.rayon_km > 0)) continue;
    for (const cible of pieces) {
      if (cible.detruit || cible.camp === obs.camp) continue;
      const d = distanceKm(position(obs), position(cible));
      if (d <= obs.vision.rayon_km) trouves.push({ observateurId: obs.id, cibleId: cible.id, distanceKm: d });
    }
  }
  return trouves;
}

/** Ce que voit un camp : ses propres pièces, plus les pièces adverses dans la vision de l'une des siennes. */
export function visiblesPour(camp, pieces) {
  const visibles = new Set(pieces.filter((p) => p.camp === camp && !p.detruit).map((p) => p.id));
  for (const c of contacts(pieces)) if (pieces.find((p) => p.id === c.observateurId).camp === camp) visibles.add(c.cibleId);
  return visibles;
}
