// Terrain côté navigateur : charge les tuiles vectorielles de la zone, expose l'instance de terrain au moteur, règle et surcouche « ce que voit le moteur ».
import { creerTerrain, coinTuile, tuileDe, cleTuile, ZOOM_TERRAIN, FORET, EAU, ROUTE } from './terrain.js';
import { decoder } from './mvt.js';

const STOCK = 'wg.terrain';
const TUILES_VUE_MAX = 40;
const SOURCE = 'terrain-vu-';
const COULEURS = { [FORET]: [46, 175, 67, 190], [EAU]: [30, 120, 255, 160], [ROUTE]: [255, 160, 40, 190] };
const $ = (id) => document.getElementById(id);

const cfg = { url: null, maxzoom: 0 };
const archives = new Map();
let reglage = { actif: true, voir: false };
try { reglage = { ...reglage, ...JSON.parse(localStorage.getItem(STOCK) || '{}') }; } catch { /* stockage indisponible */ }
const sauver = () => { try { localStorage.setItem(STOCK, JSON.stringify(reglage)); } catch { /* sans effet */ } };

async function charger(z, x, y) {
  if (!cfg.url) return null;
  let archive = archives.get(cfg.url);
  if (!archive) { archive = new window.pmtiles.PMTiles(cfg.url); archives.set(cfg.url, archive); }
  const t = await archive.getZxy(z, x, y);
  return t ? decoder(new Uint8Array(t.data)) : null;
}

let surChangement = () => {};
export const terrain = creerTerrain({ charger, disponible: () => cfg.url && cfg.maxzoom >= ZOOM_TERRAIN, onChange: () => surChangement() });
terrain.actif = reglage.actif;

/** Zone de jeu courante : `url` de l'archive PMTiles (sans le préfixe pmtiles://), `maxzoom` de la zone. */
export function configurer(zone, urlPmtiles) {
  const url = urlPmtiles.replace(/^pmtiles:\/\//, '');
  if (cfg.url === url) return;
  cfg.url = url; cfg.maxzoom = zone.maxzoom;
  terrain.vider();
  majEtat();
}

function majEtat() {
  const el = $('terrain-etat');
  if (!el) return;
  const r = terrain.rapport();
  let texte;
  if (!r.disponible) texte = `Indisponible sur cette zone : il faut le zoom ${ZOOM_TERRAIN} (celle-ci s'arrête au ${cfg.maxzoom}). Tout est traité comme de la plaine.`;
  else if (!r.voulu) texte = 'Désactivé : tout est traité comme de la plaine.';
  else texte = `${r.chargees} tuile${r.chargees > 1 ? 's' : ''} chargée${r.chargees > 1 ? 's' : ''}${r.enAttente ? `, ${r.enAttente} en cours` : ''}${r.echecs ? ` · ${r.echecs} en échec (traitées comme de la plaine)` : ''}.`;
  if (el.textContent !== texte) el.textContent = texte;
}

// ---------- surcouche ----------
let carte = null, tuilesAffichees = new Set(), avant = null;

function image(grille) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d'), data = ctx.createImageData(256, 256);
  for (let i = 0; i < grille.length; i += 1) {
    const v = grille[i];
    const col = v & ROUTE ? COULEURS[ROUTE] : v & EAU ? COULEURS[EAU] : v & FORET ? COULEURS[FORET] : null;
    if (col) data.data.set(col, i * 4);
  }
  ctx.putImageData(data, 0, 0);
  return c.toDataURL('image/png');
}

function retirerSurcouche() {
  if (!carte) return;
  for (const id of tuilesAffichees) { if (carte.getLayer(id)) carte.removeLayer(id); if (carte.getSource(id)) carte.removeSource(id); }
  tuilesAffichees = new Set();
}

async function dessinerSurcouche() {
  if (!carte || !reglage.voir || !terrain.actif) { retirerSurcouche(); return; }
  const b = carte.getBounds(), z = ZOOM_TERRAIN;
  const a = tuileDe(b.getWest(), b.getNorth(), z), c = tuileDe(b.getEast(), b.getSouth(), z);
  const liste = [];
  for (let x = Math.floor(a.x); x <= Math.floor(c.x); x += 1) for (let y = Math.floor(a.y); y <= Math.floor(c.y); y += 1) liste.push({ x, y });
  if (liste.length > TUILES_VUE_MAX) { retirerSurcouche(); majVue(`Zoomez pour voir le terrain (${liste.length} tuiles dans la vue, ${TUILES_VUE_MAX} au plus).`); return; }
  majVue('');
  await terrain.assurerTuiles(liste);
  const voulues = new Set(liste.map(({ x, y }) => `${SOURCE}${cleTuile(z, x, y)}`));
  for (const id of tuilesAffichees) if (!voulues.has(id)) { if (carte.getLayer(id)) carte.removeLayer(id); if (carte.getSource(id)) carte.removeSource(id); tuilesAffichees.delete(id); }
  const sous = carte.getStyle().layers.find((l) => avant && l.id.startsWith(avant));
  for (const { x, y } of liste) {
    const id = `${SOURCE}${cleTuile(z, x, y)}`, g = terrain.grille(z, x, y);
    if (!g || carte.getSource(id)) continue;
    const [w, n] = coinTuile(z, x, y), [e, s] = coinTuile(z, x + 1, y + 1);
    carte.addSource(id, { type: 'image', url: image(g), coordinates: [[w, n], [e, n], [e, s], [w, s]] });
    carte.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.55, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, sous ? sous.id : undefined);
    tuilesAffichees.add(id);
  }
}

function majVue(texte) { const el = $('terrain-vue'); if (el) el.textContent = texte; }

/** Monte les réglages du panneau et la surcouche. `couchePieces` : préfixe d'id des couches de pièces (la surcouche se glisse dessous). */
export function monter(map, couchePieces) {
  carte = map; avant = couchePieces;
  surChangement = () => { majEtat(); document.dispatchEvent(new CustomEvent('wg:terrain')); };
  const actif = $('terrain-actif'), voir = $('terrain-voir');
  if (actif) { actif.checked = reglage.actif; actif.addEventListener('change', () => { reglage = { ...reglage, actif: actif.checked }; sauver(); terrain.actif = actif.checked; dessinerSurcouche(); }); }
  if (voir) { voir.checked = reglage.voir; voir.addEventListener('change', () => { reglage = { ...reglage, voir: voir.checked }; sauver(); dessinerSurcouche(); }); }
  map.on('moveend', () => { if (reglage.voir) dessinerSurcouche(); });
  map.on('styledata', () => { if (reglage.voir && tuilesAffichees.size && ![...tuilesAffichees].every((id) => map.getSource(id))) { tuilesAffichees = new Set(); dessinerSurcouche(); } });
  majEtat();
  if (reglage.voir) dessinerSurcouche();
}
