// Règles de pièces : unités documentées, qui détruit qui, endurance des drones, brouillage. Fonctions pures (testables avec node).
import { destination, distanceKm, pointVers } from './geo.js';

// ---------- unités ----------
export const rayonDeSurfaceKm = (km2) => Math.sqrt(km2 / Math.PI);
export const rayonDeSurfaceM = (m2) => Math.sqrt(m2 / Math.PI);
/** Rayon d'observation en km : une surface documentée (drone) devient le rayon du disque équivalent. */
export const rayonVision = (vision) => (vision && vision.surface_km2 > 0 ? rayonDeSurfaceKm(vision.surface_km2) : (vision && vision.rayon_km) || 0);

// ---------- feu ----------
export const categorie = (p) => p.categorie || 'autre';
/** 'aucun' | 'direct' (tir sur une cible) | 'explosion' (la pièce se détruit sur sa cible) | 'zone' (tir sur une zone, avec dispersion). */
export const modeFeu = (p) => (p.feu && p.feu.mode) || (p.feu && p.feu.portee_km > 0 ? 'direct' : 'aucun');
export const aFeu = (p) => modeFeu(p) !== 'aucun';
/** Cette pièce a-t-elle le droit de détruire celle-là ? (`feu.cibles` : liste de catégories, absente = tout.) */
export function peutDetruire(attaquant, cible) {
  if (!aFeu(attaquant)) return false;
  const cibles = attaquant.feu.cibles;
  return !cibles || cibles.includes('*') || cibles.includes(categorie(cible));
}

/** Nombre pseudo-aléatoire dans [0, 1[ déterminé par la graine : une même partie rejouée donne les mêmes impacts. */
export function bruit(graine) {
  let h = 2166136261;
  for (const c of String(graine)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Point d'impact d'un tir de zone : la cible décalée d'une erreur gaussienne d'écart-type `dispersionM`, déterministe. */
export function impactZone(centre, dispersionM, graine) {
  if (!(dispersionM > 0)) return [centre[0], centre[1]];
  const u1 = Math.max(bruit(`${graine}|r`), 1e-9), u2 = bruit(`${graine}|a`);
  const ecartM = dispersionM * Math.sqrt(-2 * Math.log(u1));
  return destination(centre, 360 * u2, ecartM / 1000);
}

/** Pièces détruites par un événement de combat. Rend [{ id, cause }]. Le tir direct ne touche que sa cible ; frappe et tir de zone touchent tout ce qui est dans le rayon. */
export function effets(evenement, pieces) {
  const par = (id) => pieces.find((p) => p.id === id);
  const attaquant = par(evenement.pieceId);
  if (!attaquant) return [];
  if (evenement.type === 'tir') {
    const cible = par(evenement.cibleId);
    return cible && !cible.detruit && peutDetruire(attaquant, cible) ? [{ id: cible.id, cause: 'tir' }] : [];
  }
  if (evenement.type !== 'frappe' && evenement.type !== 'tir_zone') return [];
  const touches = pieces.filter((p) => !p.detruit && p.id !== attaquant.id && peutDetruire(attaquant, p)
    && distanceKm([p.lng, p.lat], evenement.impact) * 1000 <= evenement.rayonM)
    .map((p) => ({ id: p.id, cause: evenement.type === 'frappe' ? 'explosion' : 'artillerie' }));
  return evenement.type === 'frappe' ? [{ id: attaquant.id, cause: 'explosion' }, ...touches] : touches;
}

// ---------- drones : endurance et retour ----------
export const estDrone = (p) => p.endurance_min > 0;
export const enVol = (p) => estDrone(p) && p.etat === 'vol';
export const retourPossible = (p) => estDrone(p) && p.retour === true;
export const enduranceRestante = (p) => (p.endurance_restante_min !== undefined && p.endurance_restante_min !== null ? p.endurance_restante_min : p.endurance_min);

/** Marge prise sur le trajet de retour pour décider de rentrer (10 %). */
const MARGE_RETOUR = 1.1;
/** Minutes de vol nécessaires pour rentrer à `poste` à la vitesse `kmh`, marge comprise. */
export const minutesRetour = (p, poste, kmh) => (poste && kmh > 0 ? (distanceKm([p.lng, p.lat], [poste.lng, poste.lat]) / kmh) * 60 * MARGE_RETOUR : 0);
/** Un drone en vol qui peut rentrer doit le faire dès qu'il ne lui reste que le temps du retour. */
export const doitRentrer = (p, poste, kmh) => retourPossible(p) && enVol(p) && Boolean(poste) && enduranceRestante(p) <= minutesRetour(p, poste, kmh);

// ---------- brouillage ----------
export const rayonBrouillage = (p) => (p.brouillage && p.brouillage.rayon_km > 0 ? p.brouillage.rayon_km : 0);
/** Brouilleurs vivants du camp adverse à `camp`, avec leur rayon. */
export const brouilleursContre = (camp, pieces) => pieces.filter((q) => q.camp !== camp && !q.detruit && rayonBrouillage(q) > 0);
/** Plus courte distance (km) entre `centre` et une trajectoire, par échantillonnage tous les 0,5 km. */
export function distanceMinTrajet(points, centre) {
  let mini = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    mini = Math.min(mini, distanceKm(points[i], centre));
    if (i === 0) continue;
    const longueur = distanceKm(points[i - 1], points[i]);
    for (let d = 0.5; d < longueur; d += 0.5) mini = Math.min(mini, distanceKm(pointVers(points[i - 1], points[i], d), centre));
  }
  return mini;
}
/** Un drone en vol, sans immunité, dans la zone d'un brouilleur ennemi : renvoie ce brouilleur, sinon null. */
export function brouilleSur(p, pieces) {
  if (!enVol(p) || p.immunise_brouillage) return null;
  return brouilleursContre(p.camp, pieces).find((q) => distanceKm([p.lng, p.lat], [q.lng, q.lat]) <= rayonBrouillage(q)) || null;
}
