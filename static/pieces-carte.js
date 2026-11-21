// Pièces sur la carte : portées, liens, traces (couches) et pions (marqueurs).
import * as maplibre from './vendor/maplibre-gl.mjs';
import { capVers, cercle, distanceKm } from './geo.js';
import { symbole } from './symboles.js';
import { estJoueur, role } from './role.js';
import { estPoste, exigePoste, etatLiaison, porteeLiaison } from './moteur.js';
import { enVol, estDrone, rayonBrouillage, rayonVision } from './regles.js';
import { h, sourceGeojson } from './ui.js';
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
      id: 'sillage-halo',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'sillage'],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': couleurDe, 'line-width': 7, 'line-blur': 5, 'line-opacity': ['*', ['get', 'a'], 0.45] }
    },
    {
      id: 'sillage',
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'genre'], 'sillage'],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['get', 'a'], 0, 0.5, 1, 2.4], 'line-opacity': ['*', ['get', 'a'], 0.85] }
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

// ---------- sillages : la trace lumineuse des drones en vol, qui s'efface derrière eux ----------
const SILLAGE_POINTS = 26;
const histoire = new Map(); // id -> positions récentes
function majSillages(pieces) {
  for (const p of pieces) {
    if (!estDrone(p) || !enVol(p) || p.detruit) {
      histoire.delete(p.id);
      continue;
    }
    const h_ = histoire.get(p.id) || [];
    const fin = h_[h_.length - 1];
    if (!fin || distanceKm(fin, [p.lng, p.lat]) > 0.00002) histoire.set(p.id, [...h_, [p.lng, p.lat]].slice(-SILLAGE_POINTS));
  }
}
function sillages(montrees) {
  const sortie = [];
  for (const p of montrees) {
    const pts = histoire.get(p.id);
    if (!pts || pts.length < 2) continue;
    for (let k = 1; k < pts.length; k += 1)
      sortie.push({ type: 'Feature', properties: { camp: p.camp, genre: 'sillage', a: k / pts.length }, geometry: { type: 'LineString', coordinates: [pts[k - 1], pts[k]] } });
  }
  return sortie;
}

export function collection() {
  const montrees = state.pieces.filter((p) => estVisible(p) && !p.detruit && (!estJoueur() || p.camp === role.camp)); // un joueur ne voit ni portées ni liens de l'adversaire
  const visibles = state.portees === 'toutes' ? montrees : state.portees === 'selection' ? montrees.filter((p) => p.id === state.selection) : [];
  majSillages(state.pieces);
  const features = [...sillages(montrees)];
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
    if (exigePoste(p)) {
      // le périmètre d'un drone : jusqu'où il peut s'éloigner de son équipe de pilotes (anneau autour de l'équipe)
      const poste = etatLiaison(p, state.pieces).poste;
      if (poste && !poste.detruit && estVisible(poste))
        features.push({
          type: 'Feature',
          properties: { ...proprietes, genre: 'liaison' },
          geometry: { type: 'LineString', coordinates: cercle([poste.lng, poste.lat], porteeLiaison(p, poste)) }
        });
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
  // Un drone en vol montre toujours ce qu'il observe, même quand les portées ne sont pas affichées : c'est lui qu'on suit des yeux.
  for (const p of montrees)
    if (estDrone(p) && enVol(p) && !visibles.includes(p) && rayonVision(p.vision) > 0)
      features.push({
        type: 'Feature',
        properties: { camp: p.camp, id: p.id, genre: 'vision' },
        geometry: { type: 'Polygon', coordinates: [cercle([p.lng, p.lat], rayonVision(p.vision))] }
      });
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

export const rafraichirCarte = sourceGeojson(() => state.map, SOURCE_ID, collection);

// ---------- marqueurs ----------
export const modeleDe = (p) => state.catalogue.find((m) => m.id === p.type) || { nom: p.nom };

// ---------- drones : cap et mouvement ----------
const DUREE_MOUVEMENT_MS = 2600; // un drone qui vient de bouger garde son souffle et ses rotors à plein régime
const dernier = new Map(); // id -> { lng, lat, cap, t, minuteur }
/** Retient la direction du dernier déplacement (le drone se tourne vers elle) et signale qu'il est en mouvement. */
function suivreMouvement(p, el) {
  if (!estDrone(p)) return;
  const d = dernier.get(p.id);
  if (!d) dernier.set(p.id, { lng: p.lng, lat: p.lat, cap: 0, t: -1e9, minuteur: 0 });
  else if ((d.lng !== p.lng || d.lat !== p.lat) && distanceKm([d.lng, d.lat], [p.lng, p.lat]) > 0.00002) {
    d.cap = capVers([d.lng, d.lat], [p.lng, p.lat]);
    d.lng = p.lng;
    d.lat = p.lat;
    d.t = performance.now();
    clearTimeout(d.minuteur);
    d.minuteur = setTimeout(() => el.classList.remove('en-mouvement'), DUREE_MOUVEMENT_MS);
  }
  const e = dernier.get(p.id);
  el.style.setProperty('--cap', `${Math.round(e.cap)}deg`);
  el.classList.toggle('en-mouvement', performance.now() - e.t < DUREE_MOUVEMENT_MS && enVol(p));
}

export function styleMarqueur(p, el) {
  el.style.setProperty('--c', COULEURS[p.camp]);
  if (el.dataset.camp !== p.camp) {
    const drone = estDrone(p);
    const s = symbole(modeleDe(p), p.camp, drone ? 36 : 22);
    if (drone) {
      // trois sortes de drones, trois silhouettes : anneau pointillé qui tourne (observation), anneau plein qui pulse (attaque), anneau fin (filoguidé)
      s.classList.add('aerien');
      s.append(h('i', { class: 'souffle' }), h('i', { class: 'halo' }));
      el.dataset.drone = ['drone-isr', 'drone-owa', 'drone-filoguide'].includes(p.type) ? p.type.slice(6) : 'autre';
    }
    el.replaceChildren(s);
    el.dataset.camp = p.camp;
  } // l'identité du symbole suit le camp
  el.title = `${p.nom} (${NOM_CAMP[p.camp]})${p.detruit ? ', détruit' : ''}`;
  el.classList.toggle('choisi', p.id === state.selection);
  el.classList.toggle('detruit', !!p.detruit);
  suivreMouvement(p, el);
  el.classList.toggle('en-vol', estDrone(p) && enVol(p) && !p.detruit); // un drone en vol se lit comme tel : en altitude, avec son ombre au sol
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
