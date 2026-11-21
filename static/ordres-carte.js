// Couches de la carte pour les consignes : trajets prévus et points d'itinéraire.
import { listerPieces } from './pieces.js';
import { SOURCE_CONSIGNES, fileDe, pieceCourante, state } from './ordres-etat.js';

const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };

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

export function rafraichirCarte() { const s = state.map && state.map.getSource(SOURCE_CONSIGNES); if (s) s.setData(collection()); }
export function setTheme(t) { state.theme = t; }
