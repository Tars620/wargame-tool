// Moteur des consignes : fonctions pures (aucun accès au navigateur), donc testables avec node.
// Une pièce : { id, camp, categorie, lng, lat, mouvement:{min,max}, feu:{mode,portee_km,...}, vision:{rayon_km|surface_km2}, meteo_max?, endurance_min?, ... } (voir catalogue.js)
// Une consigne : { type: 'aller'|'observer'|'engager'|'rentrer', ... }
import { distanceKm, longueurKm, pointVers } from './geo.js';
import { aFeu, brouilleursContre, categorie, distanceMinTrajet, enduranceRestante, estDrone, impactZone, minutesRetour, modeFeu, peutDetruire, rayonBrouillage,
  rayonDeSurfaceM, rayonVision, retourPossible } from './regles.js';
import { ROUTE, eauInterdite, partHorsRoute, premiereEau, routeSeule, voit } from './terrain.js';

export const ALLURES = { prudente: 'Prudente', normale: 'Normale', maximale: 'Maximale' };
const MARGE_PORTEE = 0.999; // on s'arrête juste à l'intérieur de la portée de feu

export const position = (p) => [p.lng, p.lat];

// ---------- liaison avec une équipe de pilotes ----------
// Une pièce « équipe » porte commande. Un drone porte liaison: true : il doit être rattaché à une équipe de son camp et rester dans sa propre
// portée opérationnelle (portee_op_km) autour d'elle. Une équipe peut avoir autant de drones qu'on veut ; un drone n'a qu'une équipe.
export const LIAISON_KM = 30; // portée par défaut d'un drone qui n'en déclare pas
export const exigePoste = (p) => Boolean(p.liaison);
export const estPoste = (p) => Boolean(p.commande);
export const porteeLiaison = (drone, poste) => (drone.portee_op_km > 0 ? drone.portee_op_km : (poste && poste.commande && poste.commande.portee_km > 0 ? poste.commande.portee_km : LIAISON_KM));
const km1 = (x) => x.toFixed(1).replace('.', ',');
const LIBELLE_CIBLE = { fantassin: 'un fantassin', vehicule: 'un véhicule', artillerie: 'une artillerie', brouilleur: 'un brouilleur', pilotes: 'une équipe de pilotes', drone: 'un drone' };

/** État de la liaison d'une pièce : { requise, ok, raison: null|'aucun'|'detruit'|'camp'|'hors_portee', poste, distanceKm, porteeKm }. */
export function etatLiaison(piece, pieces) {
  if (!exigePoste(piece)) return { requise: false, ok: true, raison: null };
  const poste = piece.poste ? pieces.find((q) => q.id === piece.poste && estPoste(q)) || null : null;
  if (!poste) return { requise: true, ok: false, raison: 'aucun', poste: null, porteeKm: porteeLiaison(piece, null) };
  const porteeKm = porteeLiaison(piece, poste);
  if (poste.detruit) return { requise: true, ok: false, raison: 'detruit', poste, porteeKm };
  if (poste.camp !== piece.camp) return { requise: true, ok: false, raison: 'camp', poste, porteeKm };
  const distance = distanceKm(position(piece), position(poste));
  const ok = distance <= porteeKm + 1e-9;
  return { requise: true, ok, raison: ok ? null : 'hors_portee', poste, distanceKm: distance, porteeKm };
}

/** Phrase qui dit pourquoi une liaison est coupée (null si elle est établie). */
export function phraseLiaison(l) {
  if (!l.requise || l.ok) return null;
  if (l.raison === 'detruit') return `son équipe de pilotes (${l.poste.nom}) est détruite`;
  if (l.raison === 'camp') return `son équipe de pilotes (${l.poste.nom}) est d'un autre camp`;
  if (l.raison === 'hors_portee') return `est à ${km1(l.distanceKm)} km de son équipe de pilotes (${l.poste.nom}), ${km1(l.porteeKm)} km au plus`;
  return `n'est rattaché à aucune équipe de pilotes`;
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
      .map((q) => ({ q, d: distanceKm(position(p), position(q)) })).filter(({ q, d }) => d <= porteeLiaison(p, q)).sort((a, b) => a.d - b.d || (a.q.id < b.q.id ? -1 : 1));
    if (choix.length) liens[p.id] = choix[0].q.id;
  }
  return liens;
}

/** Erreurs de liaison d'une consigne : le drone doit être relié, et tout ce qu'il va parcourir doit rester dans sa portée autour de son équipe. */
function erreursLiaison(piece, pieces, consigne) {
  const l = etatLiaison(piece, pieces);
  if (!l.requise) return [];
  const raison = phraseLiaison(l);
  if (consigne.type === 'rentrer') return l.poste && !l.poste.detruit ? [] : [`Ce drone ${raison} : il n'a nulle part où se poser.`]; // rentrer reste permis hors de portée
  if (raison) return [`Ce drone ${raison} : il ne peut recevoir aucune consigne.`];
  const hors = (pt) => distanceKm(pt, position(l.poste));
  if (consigne.type === 'aller' && consigne.points) {
    const loin = consigne.points.find((pt) => hors(pt) > l.porteeKm + 1e-9);
    if (loin) return [`La destination est à ${km1(hors(loin))} km de son équipe de pilotes (${km1(l.porteeKm)} km au plus).`];
  }
  if (consigne.type === 'engager') {
    const cible = pieces.find((q) => q.id === consigne.cibleId);
    if (cible && aFeu(piece)) {
      const portee = piece.feu.portee_km || 0;
      const d = distanceKm(position(piece), position(cible));
      const arret = d > portee ? pointVers(position(piece), position(cible), d - portee * MARGE_PORTEE) : position(piece);
      if (hors(arret) > l.porteeKm + 1e-9) return [`Pour atteindre cette cible, le drone devrait s'éloigner à ${km1(hors(arret))} km de son équipe de pilotes (${km1(l.porteeKm)} km au plus).`];
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

const minutesTexte = (m) => String(Math.round(m * 10) / 10).replace('.', ',');

/** L'endurance restante couvre-t-elle la mission, et le retour pour un drone qui doit se poser ? */
function erreursEndurance(piece, pieces, consigne, dureeMin, v) {
  if (consigne.type === 'rentrer' || !Number.isFinite(dureeMin)) return [];
  const reste = enduranceRestante(piece);
  const equipe = pieces.find((q) => q.id === piece.poste && estPoste(q));
  const dernier = consigne.type === 'aller' ? consigne.points[consigne.points.length - 1] : position(piece);
  const retour = retourPossible(piece) && equipe ? minutesRetour({ lng: dernier[0], lat: dernier[1] }, equipe, v) : 0;
  if (dureeMin + retour <= reste + 1e-9) return [];
  return [`Endurance insuffisante : ${minutesTexte(dureeMin)} min de vol${retour > 0 ? ` + ${minutesTexte(retour)} min pour rentrer` : ''}, pour ${minutesTexte(reste)} min restantes.`];
}

/** Zones de brouillage ennemies que la trajectoire d'un drone traverserait. */
function avertissementsBrouillage(piece, pieces, consigne) {
  let trajet = null;
  if (consigne.type === 'aller' && consigne.points) trajet = [position(piece), ...consigne.points];
  else if (consigne.type === 'engager') { const cible = pieces.find((q) => q.id === consigne.cibleId); if (cible) trajet = [position(piece), position(cible)]; }
  if (!trajet) return [];
  return brouilleursContre(piece.camp, pieces).filter((q) => distanceMinTrajet(trajet, position(q)) <= rayonBrouillage(q))
    .map((q) => `La trajectoire traverse la zone de brouillage de ${q.nom} (${km1(rayonBrouillage(q))} km) : le drone y serait perdu.`);
}

/** Trajet que la pièce suivrait : les points d'un « aller », ou la route directe vers un point d'arrêt à portée de feu pour « engager ». */
export function trajetPrevu(piece, pieces, consigne) {
  if (consigne.type === 'aller' && consigne.points && consigne.points.length) return [position(piece), ...consigne.points];
  if (consigne.type === 'engager' && aFeu(piece)) {
    const cible = pieces.find((q) => q.id === consigne.cibleId);
    if (!cible || cible.detruit) return null;
    const portee = piece.feu.portee_km || 0, d = distanceKm(position(piece), position(cible));
    return d > portee ? [position(piece), pointVers(position(piece), position(cible), d - portee * MARGE_PORTEE)] : null;
  }
  return null;
}

/** Terrain : l'eau arrête véhicules et artillerie ; l'artillerie ne va que sur route. Les cellules dont la tuile manque sont signalées, jamais devinées. */
function controleTerrain(piece, pieces, consigne, terrain) {
  const erreurs = [], avertissements = [];
  const trajet = trajetPrevu(piece, pieces, consigne);
  if (!trajet) return { erreurs, avertissements };
  if (eauInterdite(piece)) {
    const eau = premiereEau(trajet, terrain);
    if (eau) erreurs.push(`Le trajet traverse de l'eau, à ${km1(eau.distanceKm)} km du départ : cette pièce ne peut pas la franchir (hors route ou pont).`);
  }
  if (routeSeule(piece) && consigne.type === 'aller') {
    const but = consigne.points[consigne.points.length - 1];
    const surRoute = terrain.classe(but[0], but[1]);
    if (surRoute !== null && !(surRoute & ROUTE)) erreurs.push("Cette pièce ne se déplace que sur route : la destination n'est pas sur une route reconnue.");
    const h = partHorsRoute(trajet, terrain);
    if (!erreurs.length && h.part > 0.1) avertissements.push(`${Math.round(h.part * 100)} % du trajet (tracé en ligne droite) n'est pas sur une route : ajoutez des points le long de la route.`);
  }
  const m = partHorsRoute(trajet, terrain).inconnues;
  if (m > 0) avertissements.push('Terrain pas encore chargé sur une partie du trajet : la vérification est incomplète.');
  return { erreurs, avertissements };
}

/**
 * Une consigne est-elle compatible avec les capacités de la pièce ?
 * Rend { ok, erreurs, avertissements, distanceKm, dureeMin }. Les erreurs interdisent la consigne,
 * les avertissements la laissent passer (météo, délais).
 */
export function verifier(piece, consigne, { pieces = [], meteo = null, terrain = null } = {}) {
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
    if (!(rayonVision(piece.vision) > 0)) avertissements.push("Cette pièce n'a aucune vision : l'observation ne servira à rien.");
  } else if (consigne.type === 'engager') {
    const cible = pieces.find((p) => p.id === consigne.cibleId);
    if (!aFeu(piece)) erreurs.push("Cette pièce n'a aucun feu.");
    if (!cible) erreurs.push('Choisissez une cible.');
    else if (cible.detruit) erreurs.push('La cible est déjà détruite.');
    else if (cible.camp === piece.camp) erreurs.push('La cible est du même camp.');
    else if (aFeu(piece) && !peutDetruire(piece, cible)) erreurs.push(`Cette pièce ne peut pas détruire ${LIBELLE_CIBLE[categorie(cible)] || 'cette pièce'}.`);
    else if (aFeu(piece)) {
      const portee = piece.feu.portee_km || 0;
      distance = distanceKm(position(piece), position(cible));
      const aRejoindre = Math.max(distance - portee, 0);
      if (aRejoindre > 0 && !(v > 0)) erreurs.push('Cible hors de portée et pièce immobile.');
      else duree = minutes(aRejoindre, v);
      if (aRejoindre > 0 && portee > 0) avertissements.push(`Cible hors de portée (${km1(distance)} km pour ${km1(portee)} km) : la pièce devra d'abord s'approcher.`);
    }
  } else if (consigne.type === 'rentrer') {
    const equipe = pieces.find((q) => q.id === piece.poste && estPoste(q));
    if (!retourPossible(piece)) erreurs.push(estDrone(piece) ? 'Ce drone est à sens unique : il ne rentre pas.' : 'Seul un drone d\'observation peut rentrer se poser.');
    else if (equipe && !equipe.detruit) { distance = distanceKm(position(piece), position(equipe)); duree = minutes(distance, v); }
  } else erreurs.push('Consigne inconnue.');

  if (!erreurs.length) erreurs.push(...erreursLiaison(piece, pieces, consigne));
  if (!erreurs.length && terrain && terrain.actif && !estDrone(piece)) { const t = controleTerrain(piece, pieces, consigne, terrain); erreurs.push(...t.erreurs); avertissements.push(...t.avertissements); }
  if (!erreurs.length && estDrone(piece)) erreurs.push(...erreursEndurance(piece, pieces, consigne, duree, v));
  if (!erreurs.length && estDrone(piece) && !piece.immunise_brouillage) avertissements.push(...avertissementsBrouillage(piece, pieces, consigne));
  if (estPoste(piece) && consigne.type === 'aller' && consigne.points && consigne.points.length) {
    const but = consigne.points[consigne.points.length - 1];
    const perdus = pieces.filter((q) => q.poste === piece.id && exigePoste(q) && !q.detruit && distanceKm(position(q), but) > porteeLiaison(q, piece) + 1e-9);
    if (perdus.length) avertissements.push(`${perdus.length} drone${perdus.length > 1 ? 's' : ''} rattaché${perdus.length > 1 ? 's' : ''} à cette équipe ser${perdus.length > 1 ? 'ont' : 'a'} hors de portée à l'arrivée : liaison perdue.`);
  }

  const vent = meteo && meteo.vent_kmh;
  if (piece.meteo_max && piece.meteo_max.vent_kmh && vent > piece.meteo_max.vent_kmh) {
    avertissements.push(`Vent prévu ${Math.round(vent)} km/h, au-dessus de la limite de cette pièce (${piece.meteo_max.vent_kmh} km/h).`);
  }
  return { ok: erreurs.length === 0, erreurs, avertissements, distanceKm: distance, dureeMin: duree };
}

/**
 * Fait avancer une pièce de `dtMin` minutes de jeu selon sa consigne active.
 * Ne modifie rien : rend { position, consigne (mise à jour), termine, evenements }. `graine` rend déterministes les impacts de tir de zone.
 */
export function avancer(piece, consigne, dtMin, pieces = [], graine = '', terrain = null) {
  const evenements = [];
  const v = vitesse(piece, consigne.allure);
  const pas = (v * dtMin) / 60;
  let pos = position(piece);

  if (consigne.type === 'aller') {
    let reste = pas;
    let etape = consigne.etape || 0;
    const depart = pos;
    while (reste > 0 && etape < consigne.points.length) {
      const but = consigne.points[etape];
      const d = distanceKm(pos, but);
      if (reste >= d) { pos = [but[0], but[1]]; reste -= d; etape += 1; } else { pos = pointVers(pos, but, reste); reste = 0; }
    }
    const arret = arretEau(piece, depart, pos, terrain);
    if (arret) { evenements.push({ type: 'bloque', cause: 'eau', pieceId: piece.id, position: arret }); return { position: arret, consigne: { ...consigne, etape }, termine: true, evenements }; }
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

  if (consigne.type === 'rentrer') {
    const equipe = pieces.find((p) => p.id === piece.poste && estPoste(p));
    if (!equipe || equipe.detruit) { evenements.push({ type: 'sans_equipe', pieceId: piece.id }); return { position: pos, consigne, termine: true, evenements }; }
    const d = distanceKm(pos, position(equipe));
    if (pas >= d) { evenements.push({ type: 'atterri', pieceId: piece.id, equipeId: equipe.id }); return { position: position(equipe), consigne, termine: true, evenements }; }
    return { position: pointVers(pos, position(equipe), pas), consigne, termine: false, evenements };
  }

  // engager : selon le feu de la pièce, se détruire sur la cible (explosion), tirer sur la cible (direct) ou sur sa zone (zone)
  const cible = pieces.find((p) => p.id === consigne.cibleId);
  if (!cible || cible.detruit) { evenements.push({ type: 'cible_perdue', pieceId: piece.id, cibleId: consigne.cibleId }); return { position: pos, consigne, termine: true, evenements }; }
  const d = distanceKm(pos, position(cible));
  const mode = modeFeu(piece);
  const portee = piece.feu.portee_km || 0;
  if (mode === 'explosion') {
    if (pas >= d) {
      evenements.push({ type: 'frappe', pieceId: piece.id, cibleId: cible.id, impact: position(cible), rayonM: rayonDeSurfaceM(piece.feu.zone_m2 || 0) });
      return { position: position(cible), consigne, termine: true, evenements };
    }
    return { position: pointVers(pos, position(cible), pas), consigne, termine: false, evenements };
  }
  if (d <= portee) {
    if (mode === 'zone') {
      evenements.push({ type: 'tir_zone', pieceId: piece.id, cibleId: cible.id, distanceKm: d, rayonM: piece.feu.rayon_m || 0,
        impact: impactZone(position(cible), piece.feu.dispersion_m, `${graine}|${piece.id}|${cible.id}`) });
    } else evenements.push({ type: 'tir', pieceId: piece.id, cibleId: cible.id, distanceKm: d });
    return { position: pos, consigne, termine: true, evenements };
  }
  const avance = Math.min(pas, d - portee * MARGE_PORTEE);
  const nouvelle = pointVers(pos, position(cible), avance);
  const arret = arretEau(piece, pos, nouvelle, terrain);
  if (arret) { evenements.push({ type: 'bloque', cause: 'eau', pieceId: piece.id, position: arret }); return { position: arret, consigne, termine: true, evenements }; }
  return { position: nouvelle, consigne, termine: false, evenements };
}

/** Dernier point sec d'un déplacement qui entrerait dans l'eau (pièce sensible à l'eau, sous terrain actif) ; null si rien ne l'arrête. */
function arretEau(piece, de, vers, terrain) {
  if (!terrain || !terrain.actif || !eauInterdite(piece) || estDrone(piece)) return null;
  const eau = premiereEau([de, vers], terrain);
  if (!eau) return null;
  const d = distanceKm(de, eau.point);
  return d > 0.03 ? pointVers(de, vers, d - 0.025) : de;
}

/** Contacts : pour chaque pièce, les pièces adverses comprises dans son rayon de vision. */
export function contacts(pieces, terrain = null) {
  const trouves = [];
  for (const obs of pieces) {
    if (obs.detruit || (estDrone(obs) && obs.etat !== 'vol')) continue; // un drone au sol n'observe rien
    const rayon = rayonVision(obs.vision);
    if (!(rayon > 0)) continue;
    for (const cible of pieces) {
      if (cible.detruit || cible.camp === obs.camp) continue;
      const d = distanceKm(position(obs), position(cible));
      if (d <= rayon && voit(obs, cible, terrain)) trouves.push({ observateurId: obs.id, cibleId: cible.id, distanceKm: d });
    }
  }
  return trouves;
}

/** Ce que voit un camp : ses propres pièces, plus les pièces adverses dans la vision de l'une des siennes. */
export function visiblesPour(camp, pieces, terrain = null) {
  const visibles = new Set(pieces.filter((p) => p.camp === camp && !p.detruit).map((p) => p.id));
  for (const c of contacts(pieces, terrain)) if (pieces.find((p) => p.id === c.observateurId).camp === camp) visibles.add(c.cibleId);
  return visibles;
}
