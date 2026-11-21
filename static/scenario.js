// Scénario : assemblage, validation à l'ouverture et export GeoJSON. Fonctions pures (testables avec node).
// Un scénario ouvert vient de l'extérieur : rien n'est repris sans avoir été vérifié, et seuls les champs connus sont gardés.
import { sidc } from './symboles.js';

export const FORMAT = 'wargame-scenario';
export const VERSION = 1;
export const TAILLE_MAX_OCTETS = 5 * 1024 * 1024;
const MAX = { pieces: 2000, dessins: 1000, points: 5000, consignes: 5000, journal: 1000 };
const CAMPS = ['bleu', 'rouge'];
const CAMPS_DESSIN = ['bleu', 'rouge', 'neutre'];
const POINTS_MIN = { front: 2, limite: 2, zone: 3 };
const TYPES_CONSIGNE = ['aller', 'observer', 'engager'];
const ALLURES = ['prudente', 'normale', 'maximale'];
const STATUTS = ['attente', 'lance', 'en_cours', 'terminee'];
const GENRES_JOURNAL = ['info', 'op', 'alerte', 'tir', 'contact'];

const nombre = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const texte = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const point = (p) => Array.isArray(p) && p.length === 2 && nombre(p[0], -360, 360) && nombre(p[1], -90, 90);
const points = (liste, min) => Array.isArray(liste) && liste.length >= min && liste.length <= MAX.points && liste.every(point);
const brut = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

class Refus extends Error {}
function exiger(condition, message) { if (!condition) throw new Refus(message); }

function piece(p, i) {
  const ou = `pièce ${i + 1}`;
  exiger(brut(p), `${ou} : objet attendu`);
  exiger(texte(p.id, 40) && texte(p.type, 40) && texte(p.nom, 60), `${ou} : identifiant, type ou nom invalide`);
  exiger(CAMPS.includes(p.camp), `${ou} : camp inconnu`);
  exiger(nombre(p.lng, -360, 360) && nombre(p.lat, -90, 90), `${ou} : position invalide`);
  exiger(brut(p.mouvement) && nombre(p.mouvement.min, 0, 5000) && nombre(p.mouvement.max, 0, 5000), `${ou} : vitesses invalides`);
  exiger(brut(p.feu) && nombre(p.feu.portee_km, 0, 5000) && nombre(p.feu.puissance, 0, 10), `${ou} : feu invalide`);
  exiger(brut(p.vision) && nombre(p.vision.rayon_km, 0, 5000), `${ou} : vision invalide`);
  const meteo = brut(p.meteo_max) && nombre(p.meteo_max.vent_kmh, 0, 1000) ? { vent_kmh: p.meteo_max.vent_kmh } : null;
  const dep = brut(p.dernier_deplacement) && nombre(p.dernier_deplacement.km, 0, 1e6) && points(p.dernier_deplacement.trace, 2)
    ? { km: p.dernier_deplacement.km, trace: p.dernier_deplacement.trace.map((q) => [q[0], q[1]]) } : null;
  return { id: p.id, type: p.type, nom: p.nom, camp: p.camp, lng: p.lng, lat: p.lat,
    mouvement: { min: p.mouvement.min, max: p.mouvement.max }, feu: { portee_km: p.feu.portee_km, puissance: p.feu.puissance },
    vision: { rayon_km: p.vision.rayon_km }, meteo_max: meteo, dernier_deplacement: dep };
}

function dessin(d, i) {
  const ou = `dessin ${i + 1}`;
  exiger(brut(d), `${ou} : objet attendu`);
  exiger(texte(d.id, 40) && texte(d.nom, 60), `${ou} : identifiant ou nom invalide`);
  exiger(d.genre in POINTS_MIN, `${ou} : genre inconnu`);
  exiger(CAMPS_DESSIN.includes(d.camp), `${ou} : camp inconnu`);
  exiger(points(d.points, POINTS_MIN[d.genre]), `${ou} : points invalides (au moins ${POINTS_MIN[d.genre]})`);
  const sortie = { id: d.id, genre: d.genre, nom: d.nom, camp: d.camp, points: d.points.map((q) => [q[0], q[1]]) };
  if (d.couloir_km !== undefined) { exiger(nombre(d.couloir_km, 0, 1000), `${ou} : largeur de couloir invalide`); sortie.couloir_km = d.couloir_km; }
  return sortie;
}

function consigne(c, idPiece) {
  const ou = `consigne de ${idPiece}`;
  exiger(brut(c), `${ou} : objet attendu`);
  exiger(texte(c.id, 40) && TYPES_CONSIGNE.includes(c.type) && STATUTS.includes(c.statut), `${ou} : identifiant, type ou statut invalide`);
  exiger(c.allure === undefined || ALLURES.includes(c.allure), `${ou} : allure inconnue`);
  const s = { id: c.id, type: c.type, statut: c.statut };
  if (c.allure !== undefined) s.allure = c.allure;
  if (c.type === 'aller') { exiger(points(c.points, 1), `${ou} : destination invalide`); s.points = c.points.map((q) => [q[0], q[1]]); }
  if (c.type === 'observer') { exiger(nombre(c.dureeMin, 0, 1e6), `${ou} : durée invalide`); s.dureeMin = c.dureeMin; }
  if (c.type === 'engager') { exiger(texte(c.cibleId, 40), `${ou} : cible invalide`); s.cibleId = c.cibleId; }
  for (const cle of ['etape', 'ecouleMin', 'distanceKm', 'debutMs', 'finMs']) {
    if (c[cle] !== undefined) { exiger(nombre(c[cle], 0, 1e15), `${ou} : ${cle} invalide`); s[cle] = c[cle]; }
  }
  if (c.depart !== undefined) { exiger(point(c.depart), `${ou} : départ invalide`); s.depart = [c.depart[0], c.depart[1]]; }
  return s;
}

/** Vérifie un scénario venu de l'extérieur. Rend { ok, erreur, scenario } : en cas de refus, rien n'est repris. */
export function valider(objet) {
  try {
    exiger(brut(objet) && objet.format === FORMAT, 'Ce fichier n\'est pas un scénario de cet outil.');
    exiger(objet.version === VERSION, `Version de scénario non prise en charge (${objet.version}).`);
    for (const cle of ['pieces', 'dessins', 'journal']) exiger(Array.isArray(objet[cle]) && objet[cle].length <= MAX[cle], `« ${cle} » : liste attendue (${MAX[cle]} éléments au plus).`);
    exiger(brut(objet.ordres), '« ordres » : objet attendu.');
    const pieces = objet.pieces.map(piece);
    const ids = new Set(pieces.map((p) => p.id));
    exiger(ids.size === pieces.length, 'Deux pièces portent le même identifiant.');
    const dessins = objet.dessins.map(dessin);
    exiger(new Set(dessins.map((d) => d.id)).size === dessins.length, 'Deux dessins portent le même identifiant.');
    let total = 0;
    const ordres = {};
    for (const [id, liste] of Object.entries(objet.ordres)) {
      exiger(ids.has(id), `Des consignes visent une pièce absente du scénario (${id.slice(0, 20)}).`);
      exiger(Array.isArray(liste), `consignes de ${id} : liste attendue`);
      total += liste.length;
      exiger(total <= MAX.consignes, 'Trop de consignes.');
      ordres[id] = liste.map((c) => consigne(c, id));
    }
    const journal = objet.journal.map((e, i) => {
      exiger(brut(e) && nombre(e.t, 0, 1e15) && texte(e.texte, 500) && GENRES_JOURNAL.includes(e.genre), `journal ${i + 1} : entrée invalide`);
      return { t: e.t, texte: e.texte, genre: e.genre };
    });
    return { ok: true, erreur: null, scenario: { format: FORMAT, version: VERSION, enregistre: typeof objet.enregistre === 'string' ? objet.enregistre.slice(0, 40) : null, pieces, dessins, ordres, journal } };
  } catch (e) {
    if (e instanceof Refus) return { ok: false, erreur: e.message, scenario: null };
    throw e;
  }
}

/** Assemble un scénario à partir de ce que l'application garde (pièces, dessins, consignes, journal). */
export function assembler({ pieces = [], dessins = [], ordres = {}, journal = [] }, maintenant = new Date()) {
  return { format: FORMAT, version: VERSION, enregistre: maintenant.toISOString(), pieces, dessins, ordres, journal };
}

const IDENTITE = { bleu: 'friend', rouge: 'hostile', neutre: 'neutral' };

/** Export GeoJSON (WGS 84) : pièces en points avec leur code APP-6D, dessins en lignes et polygones. */
export function versGeoJSON(scenario, catalogue = []) {
  const features = [];
  for (const p of scenario.pieces) {
    const modele = catalogue.find((m) => m.id === p.type);
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {
      kind: 'unit', id: p.id, name: p.nom, side: IDENTITE[p.camp], camp: p.camp, type: p.type, sidc: modele && modele.sidc ? sidc(modele, p.camp) : null,
      speed_min_kmh: p.mouvement.min, speed_max_kmh: p.mouvement.max, fire_range_km: p.feu.portee_km, fire_power: p.feu.puissance, vision_km: p.vision.rayon_km } });
  }
  for (const d of scenario.dessins) {
    const geometry = d.genre === 'zone' ? { type: 'Polygon', coordinates: [[...d.points, d.points[0]]] } : { type: 'LineString', coordinates: d.points };
    const proprietes = { kind: 'control-measure', id: d.id, name: d.nom, measure: d.genre, side: IDENTITE[d.camp], camp: d.camp };
    if (d.genre !== 'zone' && d.couloir_km !== undefined) proprietes.corridor_km = d.couloir_km;
    features.push({ type: 'Feature', geometry, properties: proprietes });
  }
  return { type: 'FeatureCollection', name: 'wargame-tool', features };
}
