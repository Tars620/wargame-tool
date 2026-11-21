// Calculs géographiques purs (aucune dépendance au navigateur : testables avec node).
const RAYON_TERRE_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Distance sur la sphère entre deux points [lng, lat], en km. */
export function distanceKm([lng1, lat1], [lng2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * RAYON_TERRE_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point atteint en partant de [lng, lat] dans la direction `cap` (degrés, 0 = nord) sur `km`. */
export function destination([lng, lat], cap, km) {
  const d = km / RAYON_TERRE_KM;
  const phi1 = rad(lat);
  const lambda1 = rad(lng);
  const theta = rad(cap);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(Math.sin(theta) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2));
  return [((deg(lambda2) + 540) % 360) - 180, deg(phi2)];
}

/** Anneau fermé (polygone GeoJSON) de rayon `rayonKm` autour de `centre`. */
export function cercle(centre, rayonKm, pas = 72) {
  const anneau = Array.from({ length: pas }, (_, i) => destination(centre, (360 * i) / pas, rayonKm));
  return [...anneau, anneau[0]];
}

/** Durée lisible à partir de minutes (ex. 65 → « 1 h 05 »). */
export function formatDuree(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return "moins d'1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m === 60 ? `${h + 1} h 00` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** Temps de trajet (minutes) pour `km` à la vitesse minimale et maximale d'une pièce. */
export function dureesDeplacement(km, vitesseMin, vitesseMax) {
  return {
    rapide: vitesseMax > 0 ? (km / vitesseMax) * 60 : Infinity,
    lent: vitesseMin > 0 ? (km / vitesseMin) * 60 : Infinity
  };
}

export function formatKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1).replace('.', ',')} km`;
}

/** Longueur d'une ligne brisée [[lng, lat], ...], en km. */
export function longueurKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distanceKm(points[i - 1], points[i]);
  return total;
}

/** Aire (km²) d'un polygone [[lng, lat], ...] (anneau ouvert ou fermé), sur la sphère. */
export function aireKm2(points) {
  const n = points.length;
  if (n < 3) return 0;
  let somme = 0;
  for (let i = 0; i < n; i += 1) {
    const [lng1, lat1] = points[i];
    const [lng2, lat2] = points[(i + 1) % n];
    somme += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((somme * RAYON_TERRE_KM * RAYON_TERRE_KM) / 2);
}

export function formatSurface(km2) {
  if (km2 < 1) return `${Math.round(km2 * 100 * 10) / 10} ha`.replace('.', ',');
  return `${km2 < 100 ? km2.toFixed(1) : Math.round(km2)} km²`.replace('.', ',');
}

/** Cap initial (degrés, 0 = nord, sens horaire) pour aller de `a` vers `b`. */
export function capVers([lng1, lat1], [lng2, lat2]) {
  const phi1 = rad(lat1);
  const phi2 = rad(lat2);
  const dLng = rad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Avance de `km` en ligne droite de `a` vers `b`, sans jamais dépasser `b`. */
export function pointVers(a, b, km) {
  const reste = distanceKm(a, b);
  if (km >= reste) return [b[0], b[1]];
  return destination(a, capVers(a, b), Math.max(km, 0));
}
