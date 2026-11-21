// Pièces sur la carte : portées, liens, traces (couches) et pions (marqueurs).
import * as maplibre from './vendor/maplibre-gl.mjs';
import { cercle } from './geo.js';
import { symbole } from './symboles.js';
import { estJoueur, role } from './role.js';
import { estPoste, exigePoste, etatLiaison, porteeLiaison } from './moteur.js';
import { enVol, estDrone, rayonBrouillage, rayonVision } from './regles.js';
import { h } from './ui.js';
import { COULEURS, NOM_CAMP, SOURCE_ID, estVisible, state } from './pieces-etat.js';

const couleurDe = ['match', ['get', 'camp'], 'rouge', COULEURS.rouge, COULEURS.bleu];

export function layerSpecs() {
  return [
    {
      id: 'portee-vision-fond',
      type: 'fill',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'vision'],
      paint: { 'fill-color': couleurDe, 'fill-opacity': 0.09 }
    },
    {
      id: 'portee-vision',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'vision'],
      paint: { 'line-color': couleurDe, 'line-width': 1.2, 'line-opacity': 0.9 }
    },
    {
      id: 'portee-feu',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'feu'],
      paint: { 'line-color': couleurDe, 'line-width': 1.6, 'line-dasharray': [3, 2] }
    },
    {
      id: 'portee-liaison',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'liaison'],
      paint: { 'line-color': couleurDe, 'line-width': 1.2, 'line-dasharray': [1, 3], 'line-opacity': 0.9 }
    },
    {
      id: 'portee-lien',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'lien'],
      paint: { 'line-color': ['case', ['==', ['get', 'perdu'], true], '#d9a441', couleurDe], 'line-width': 1.1, 'line-opacity': 0.75 }
    },
    {
      id: 'portee-trace',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'trace'],
      paint: { 'line-color': couleurDe, 'line-width': 1.6, 'line-dasharray': [1, 2], 'line-opacity': 0.8 }
    }
  ];
}

export function collection() {
  const montrees = state.pieces.filter((p) => estVisible(p) && !p.detruit && (!estJoueur() || p.camp === role.camp)); // un joueur ne voit ni portées ni liens de l'adversaire
  const visibles = state.portees === 'toutes' ? montrees : state.portees === 'selection' ? montrees.filter((p) => p.id === state.selection) : [];
  const features = [];
  for (const p of visibles) {
    const proprietes = { camp: p.camp, id: p.id };
    const centre = [p.lng, p.lat];
    if (rayonVision(p.vision) > 0 && (!estDrone(p) || enVol(p)))
      features.push({
        type: 'Feature',
        properties: { ...proprietes, genre: 'vision' },
        geometry: { type: 'Polygon', coordinates: [cercle(centre, rayonVision(p.vision))] }
      });
    if (p.feu.portee_km > 0)
      features.push({
        type: 'Feature',
        properties: { ...proprietes, genre: 'feu' },
        geometry: { type: 'LineString', coordinates: cercle(centre, p.feu.portee_km) }
      });
    if (estPoste(p)) {
      // un anneau par portée opérationnelle distincte des drones rattachés
      const portees = new Set(state.pieces.filter((q) => q.poste === p.id && exigePoste(q) && !q.detruit).map((q) => porteeLiaison(q, p)));
      for (const r of portees)
        features.push({ type: 'Feature', properties: { ...proprietes, genre: 'liaison' }, geometry: { type: 'LineString', coordinates: cercle(centre, r) } });
    }
    if (rayonBrouillage(p) > 0)
      features.push({
        type: 'Feature',
        properties: { ...proprietes, genre: 'liaison' },
        geometry: { type: 'LineString', coordinates: cercle(centre, rayonBrouillage(p)) }
      });
    if (p.dernier_deplacement)
      features.push({
        type: 'Feature',
        properties: { ...proprietes, genre: 'trace' },
        geometry: { type: 'LineString', coordinates: p.dernier_deplacement.trace }
      });
  }
  for (const p of montrees) {
    // les liens se voient toujours : c'est la structure de commandement, pas une portée
    if (!exigePoste(p)) continue;
    const l = etatLiaison(p, state.pieces);
    if (l.poste && !l.poste.detruit && estVisible(l.poste))
      features.push({
        type: 'Feature',
        properties: { camp: p.camp, id: p.id, genre: 'lien', perdu: !l.ok },
        geometry: {
          type: 'LineString',
          coordinates: [
            [p.lng, p.lat],
            [l.poste.lng, l.poste.lat]
          ]
        }
      });
  }
  return { type: 'FeatureCollection', features };
}

export function rafraichirCarte() {
  const source = state.map && state.map.getSource(SOURCE_ID);
  if (source) source.setData(collection());
}

// ---------- marqueurs ----------
export const modeleDe = (p) => state.catalogue.find((m) => m.id === p.type) || { nom: p.nom };

export function styleMarqueur(p, el) {
  el.style.setProperty('--c', COULEURS[p.camp]);
  if (el.dataset.camp !== p.camp) {
    el.replaceChildren(symbole(modeleDe(p), p.camp, 22));
    el.dataset.camp = p.camp;
  } // l'identité du symbole suit le camp
  el.title = `${p.nom} (${NOM_CAMP[p.camp]})${p.detruit ? ', détruit' : ''}`;
  el.classList.toggle('choisi', p.id === state.selection);
  el.classList.toggle('detruit', !!p.detruit);
}

export function ajouterMarqueur(p) {
  const el = h('button', { class: 'pion', type: 'button' });
  styleMarqueur(p, el);
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    state.surChoix(p.id);
  });
  const marqueur = new maplibre.Marker({ element: el, draggable: !estJoueur() }).setLngLat([p.lng, p.lat]).addTo(state.map);
  let depart = null;
  marqueur.on('dragstart', () => {
    depart = [p.lng, p.lat];
    state.surChoix(p.id);
  });
  marqueur.on('dragend', () => {
    const { lng, lat } = marqueur.getLngLat();
    state.surDeplacement(p.id, depart, [lng, lat]);
  });
  state.marqueurs.set(p.id, marqueur);
}

export function majMarqueurs() {
  for (const p of state.pieces) {
    const m = state.marqueurs.get(p.id);
    if (m) styleMarqueur(p, m.getElement());
  }
}
