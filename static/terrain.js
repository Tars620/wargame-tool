// Terrain : forêt, eau, routes lus dans les tuiles vectorielles de la carte, puis règles de visibilité et de passage.
// Fonctions pures (le chargement des tuiles est injecté), donc testables avec node.
//   Plaine : visibilité totale.   Forêt : bloque la visibilité (un drone ne voit pas un fantassin sous les arbres).
//   Route : permet le déplacement des véhicules et de l'artillerie.   Eau : l'interdit (sauf sur une route : pont).
import { pointVers } from './geo.js';
import { categorie, estDrone } from './regles.js';

export const FORET = 1, EAU = 2, ROUTE = 4;
export const ZOOM_TERRAIN = 14;
const GRILLE = 256;                // cellules par côté de tuile (une cellule fait ~6 m à 48° N au zoom 14)
const PAS_M = 25;                  // pas d'échantillonnage le long d'un trajet
const PAS_VUE_M = 50;              // pas d'échantillonnage d'une ligne de vue ; en deçà, deux pièces se voient toujours
const MAX_ECHANTILLONS = 400;
const LARGEUR_LIGNE = 2;           // rayon (en cellules) d'une route ou d'une rivière tracée en ligne, ~12 m
const TUILES_MAX = 150;
const FORETS = new Set(['forest', 'wood']);
const ROUTES_PRAT = new Set(['major_road', 'minor_road', 'other']);   // chaussées carrossables (ni chemin piéton ni rail)
const EAUX_SANS = new Set(['fountain', 'swimming_pool', 'basin', 'reservoir_covered']);

// ---------- tuiles ----------
export const cleTuile = (z, x, y) => `${z}/${x}/${y}`;
export function tuileDe(lng, lat, z = ZOOM_TERRAIN) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
export const coinTuile = (z, x, y) => {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
};

// ---------- rasterisation ----------
function remplirPolygone(grille, formes, extent, bit) {
  const k = GRILLE / extent;
  const aretes = [];
  for (const f of formes) { const p = f.pts; for (let i = 0; i < p.length; i += 1) { const a = p[i], b = p[(i + 1) % p.length]; if (a[1] !== b[1]) aretes.push([a[0] * k, a[1] * k, b[0] * k, b[1] * k]); } }
  for (let row = 0; row < GRILLE; row += 1) {
    const yc = row + 0.5, xs = [];
    for (const [x1, y1, x2, y2] of aretes) if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const d = Math.max(0, Math.ceil(xs[i] - 0.5)), f = Math.min(GRILLE - 1, Math.floor(xs[i + 1] - 0.5));
      for (let c = d; c <= f; c += 1) grille[row * GRILLE + c] |= bit;
    }
  }
}
function tracerLigne(grille, formes, extent, bit) {
  const k = GRILLE / extent, r = LARGEUR_LIGNE;
  const tampon = (cx, cy) => {
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy;
      if (dx * dx + dy * dy <= r * r + 1 && x >= 0 && y >= 0 && x < GRILLE && y < GRILLE) grille[y * GRILLE + x] |= bit;
    }
  };
  for (const f of formes) {
    const p = f.pts;
    if (p.length === 1) tampon(p[0][0] * k, p[0][1] * k);
    for (let i = 1; i < p.length; i += 1) {
      const [x1, y1] = [p[i - 1][0] * k, p[i - 1][1] * k], [x2, y2] = [p[i][0] * k, p[i][1] * k];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
      for (let s = 0; s <= n; s += 1) tampon(x1 + ((x2 - x1) * s) / n, y1 + ((y2 - y1) * s) / n);
    }
  }
}

/** Une tuile décodée (voir mvt.js) devient une grille de 256 × 256 cellules : bits FORET, EAU, ROUTE. */
export function compilerTuile(decodee) {
  const grille = new Uint8Array(GRILLE * GRILLE);
  const faces = (nom) => (decodee[nom] ? decodee[nom].faces : []);
  const extent = (nom) => (decodee[nom] && decodee[nom].extent) || 4096;
  for (const nom of ['landuse', 'natural']) for (const f of faces(nom)) if (f.type === 3 && FORETS.has(f.props.kind)) remplirPolygone(grille, f.geom, extent(nom), FORET);
  for (const f of faces('water')) {
    if (EAUX_SANS.has(f.props.kind) || EAUX_SANS.has(f.props.kind_detail)) continue;
    if (f.type === 3) remplirPolygone(grille, f.geom, extent('water'), EAU);
    else if (f.type === 2 && (f.props.kind === 'river' || f.props.kind === 'canal')) tracerLigne(grille, f.geom, extent('water'), EAU);
  }
  for (const f of faces('roads')) if (f.type === 2 && ROUTES_PRAT.has(f.props.kind)) tracerLigne(grille, f.geom, extent('roads'), ROUTE);
  return grille;
}

// ---------- terrain chargé à la demande ----------
/**
 * `charger(z, x, y)` rend la tuile décodée (ou null si absente) ; `disponible` : la source sait-elle servir le zoom du terrain.
 * `classe(lng, lat)` est synchrone : les bits de la cellule, ou null tant que la tuile n'est pas arrivée.
 */
export function creerTerrain({ charger, disponible = true, z = ZOOM_TERRAIN, onChange = () => {} } = {}) {
  const grilles = new Map(), attente = new Map();
  let actif = true, echecs = 0;
  const dispo = () => (typeof disponible === 'function' ? Boolean(disponible()) : Boolean(disponible));
  const t = {
    get actif() { return actif && dispo(); },
    set actif(v) { actif = Boolean(v); onChange(); },
    get disponible() { return dispo(); },
    /** Oublie toutes les tuiles (changement de zone). */
    vider() { grilles.clear(); attente.clear(); echecs = 0; onChange(); },
    classe(lng, lat) {
      const { x, y } = tuileDe(lng, lat, z);
      const g = grilles.get(cleTuile(z, Math.floor(x), Math.floor(y)));
      if (!g) return null;
      return g[Math.floor((y % 1) * GRILLE) * GRILLE + Math.floor((x % 1) * GRILLE)];
    },
    grille: (zz, x, y) => grilles.get(cleTuile(zz, x, y)) || null,
    rapport: () => ({ actif: t.actif, voulu: actif, disponible: dispo(), chargees: grilles.size, enAttente: attente.size, echecs }),
    prete: () => attente.size === 0,
    /** Charge ces tuiles ({x, y} entiers) ; résout quand toutes sont arrivées. */
    async assurerTuiles(liste) {
      if (!t.actif) return;
      const promesses = [];
      for (const { x, y } of liste.slice(0, TUILES_MAX)) {
        const cle = cleTuile(z, x, y);
        if (grilles.has(cle)) continue;
        if (!attente.has(cle)) {
          const p = (async () => {
            try { const d = await charger(z, x, y); grilles.set(cle, d ? compilerTuile(d) : new Uint8Array(GRILLE * GRILLE)); } catch { echecs += 1; grilles.set(cle, new Uint8Array(GRILLE * GRILLE)); }
            attente.delete(cle); onChange();
          })();
          attente.set(cle, p);
        }
        promesses.push(attente.get(cle));
      }
      await Promise.all(promesses);
    },
    /** Les tuiles autour de chaque point, dans un rayon en km. */
    assurerPoints(points, rayonKm = 1) {
      const dLat = rayonKm / 111.32, vus = new Map();
      for (const [lng, lat] of points) {
        const dLng = rayonKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
        const a = tuileDe(lng - dLng, lat + dLat, z), b = tuileDe(lng + dLng, lat - dLat, z);
        for (let x = Math.floor(a.x); x <= Math.floor(b.x); x += 1) for (let y = Math.floor(a.y); y <= Math.floor(b.y); y += 1) vus.set(cleTuile(z, x, y), { x, y });
      }
      return t.assurerTuiles([...vus.values()]);
    },
    /** Les tuiles traversées par un trajet. */
    assurerChemin(points, margeKm = 0.15) {
      const vus = new Map();
      for (let i = 1; i < points.length; i += 1) {
        const n = Math.max(1, Math.ceil(distanceApprox(points[i - 1], points[i]) / 0.5));
        for (let s = 0; s <= n; s += 1) {
          const lng = points[i - 1][0] + ((points[i][0] - points[i - 1][0]) * s) / n, lat = points[i - 1][1] + ((points[i][1] - points[i - 1][1]) * s) / n;
          const dLat = margeKm / 111.32, dLng = margeKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
          for (const [a, b] of [[lng - dLng, lat + dLat], [lng + dLng, lat - dLat]]) { const q = tuileDe(a, b, z); vus.set(cleTuile(z, Math.floor(q.x), Math.floor(q.y)), { x: Math.floor(q.x), y: Math.floor(q.y) }); }
        }
      }
      return t.assurerTuiles([...vus.values()]);
    },
  };
  return t;
}
const distanceApprox = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), (b[1] - a[1]) * 111.32);

// ---------- règles ----------
const actifs = (terrain) => Boolean(terrain && terrain.actif);
export const eauInterdite = (p) => ['vehicule', 'artillerie'].includes(categorie(p));
export const routeSeule = (p) => p.route_seule === true;
/** Points d'un segment, un tous les `pasM` mètres, départ exclu, arrivée comprise (au plus MAX_ECHANTILLONS). */
function echantillons(a, b, pasM) {
  const km = distanceApprox(a, b);
  if (km === 0) return [];
  const pas = Math.max(pasM, (km * 1000) / MAX_ECHANTILLONS);
  const out = [];
  for (let d = pas; d < km * 1000; d += pas) out.push(pointVers(a, b, d / 1000));
  out.push([b[0], b[1]]);
  return out;
}

/**
 * Un observateur voit-il cette cible (à portée de vision déjà vérifiée) ? Sans terrain actif : toujours.
 * Une cible sous couvert forestier n'est vue de personne, sauf à moins de 50 m. Pour un observateur au sol, la forêt entre les deux coupe aussi la ligne de vue
 * (un drone regarde d'en haut : seul l'endroit où se tient la cible compte). Une cellule dont la tuile n'est pas arrivée est traitée comme cachée.
 */
export function voit(obs, cible, terrain) {
  if (!actifs(terrain)) return true;
  const a = [obs.lng, obs.lat], b = [cible.lng, cible.lat];
  if (distanceApprox(a, b) * 1000 <= PAS_VUE_M) return true;
  const sous = terrain.classe(b[0], b[1]);
  if (sous === null || (sous & FORET)) return false;
  if (estDrone(obs)) return true;
  for (const pt of echantillons(a, b, PAS_VUE_M)) { const c = terrain.classe(pt[0], pt[1]); if (c === null || (c & FORET)) return false; }
  return true;
}

/** Une cellule est-elle franchissable à pied ou en véhicule ? L'eau bloque, sauf sous une route (pont). */
const estEau = (bits) => bits !== null && (bits & EAU) !== 0 && (bits & ROUTE) === 0;
/** Sur un trajet, l'endroit où une pièce sensible à l'eau entrerait dans l'eau : { point, distanceKm } ou null. */
export function premiereEau(points, terrain) {
  if (!actifs(terrain)) return null;
  let cumul = 0;
  for (let i = 1; i < points.length; i += 1) {
    for (const pt of echantillons(points[i - 1], points[i], PAS_M)) {
      if (estEau(terrain.classe(pt[0], pt[1]))) return { point: pt, distanceKm: cumul + distanceApprox(points[i - 1], pt) };
    }
    cumul += distanceApprox(points[i - 1], points[i]);
  }
  return null;
}
/** Part (0..1) d'un trajet qui n'est pas sur une route, et nombre de cellules dont la tuile manque. */
export function partHorsRoute(points, terrain) {
  let total = 0, hors = 0, inconnues = 0;
  for (let i = 1; i < points.length; i += 1) for (const pt of echantillons(points[i - 1], points[i], PAS_M)) {
    const c = terrain.classe(pt[0], pt[1]);
    total += 1;
    if (c === null) inconnues += 1; else if (!(c & ROUTE)) hors += 1;
  }
  return { part: total ? hors / total : 0, inconnues, total };
}
