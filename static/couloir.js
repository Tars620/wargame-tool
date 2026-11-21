// Couloir de part et d'autre d'une ligne : tampon géodésique calculé par Turf (injecté, pour rester testable avec node).
export const COULOIR_DEFAUT_KM = 30;

/** Polygone des points situés à moins de `km` d'une ligne [[lng, lat], ...], ou null si la ligne est trop courte. */
export function couloir(turf, points, km = COULOIR_DEFAUT_KM) {
  if (!points || points.length < 2 || !(km > 0)) return null;
  return turf.buffer(turf.lineString(points), km, { units: 'kilometers', steps: 16 });
}
