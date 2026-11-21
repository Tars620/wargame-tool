import * as maplibre from './vendor/maplibre-gl.mjs';
import { distanceKm, cercle, formatDuree, dureesDeplacement, formatKm } from './geo.js';
import { symbole } from './symboles.js';
import { estJoueur, role } from './role.js';
import { affilies, estPoste, exigePoste, etatLiaison, lierAuto, phraseLiaison, porteeLiaison } from './moteur.js';
import { pieceDepuisModele, migrerPieces } from './catalogue.js';
import { enVol, enduranceRestante, estDrone, modeFeu, rayonBrouillage, rayonDeSurfaceKm, rayonVision } from './regles.js';

export const SOURCE_ID = 'portees';
const STORAGE_KEY = 'wg.pieces.v1';
const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };
const NOM_CAMP = { bleu: 'Bleu', rouge: 'Rouge' };
const state = { retirees: [], catalogue: [], pieces: [], camp: 'bleu', arme: null, selection: null, portees: 'selection', map: null,
  marqueurs: new Map(), racine: null, visibles: null };

// ---------- utilitaires DOM ----------
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

function nombre(valeur, min, max, repli) {
  const n = Number(String(valeur).replace(',', '.'));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : repli;
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const piece = (id) => state.pieces.find((p) => p.id === id) || null;

// ---------- persistance (navigateur) ----------
function sauver() { if (estJoueur()) return; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.pieces)); } catch { /* stockage indisponible */ } }
function charger() {
  try { const brut = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(brut) ? brut : []; } catch { return []; }
}

// ---------- état : jamais de modification en place ----------
function maj(id, patch) {
  state.pieces = state.pieces.map((p) => (p.id === id ? { ...p, ...patch } : p));
  sauver();
}

// ---------- couches de la carte ----------
const couleurDe = ['match', ['get', 'camp'], 'rouge', COULEURS.rouge, COULEURS.bleu];

export function layerSpecs() {
  return [
    { id: 'portee-vision-fond', type: 'fill', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'vision'], paint: { 'fill-color': couleurDe, 'fill-opacity': 0.09 } },
    { id: 'portee-vision', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'vision'], paint: { 'line-color': couleurDe, 'line-width': 1.2, 'line-opacity': 0.9 } },
    { id: 'portee-feu', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'feu'], paint: { 'line-color': couleurDe, 'line-width': 1.6, 'line-dasharray': [3, 2] } },
    { id: 'portee-liaison', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'liaison'], paint: { 'line-color': couleurDe, 'line-width': 1.2, 'line-dasharray': [1, 3], 'line-opacity': 0.9 } },
    { id: 'portee-lien', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'lien'],
      paint: { 'line-color': ['case', ['==', ['get', 'perdu'], true], '#d9a441', couleurDe], 'line-width': 1.1, 'line-opacity': 0.75 } },
    { id: 'portee-trace', type: 'line', source: SOURCE_ID, filter: ['==', ['get', 'genre'], 'trace'], paint: { 'line-color': couleurDe, 'line-width': 1.6, 'line-dasharray': [1, 2], 'line-opacity': 0.8 } },
  ];
}

export function collection() {
  const montrees = state.pieces.filter((p) => estVisible(p) && !p.detruit && (!estJoueur() || p.camp === role.camp)); // un joueur ne voit ni portées ni liens de l'adversaire
  const visibles = state.portees === 'toutes' ? montrees : state.portees === 'selection' ? montrees.filter((p) => p.id === state.selection) : [];
  const features = [];
  for (const p of visibles) {
    const proprietes = { camp: p.camp, id: p.id };
    const centre = [p.lng, p.lat];
    if (rayonVision(p.vision) > 0 && (!estDrone(p) || enVol(p))) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'vision' }, geometry: { type: 'Polygon', coordinates: [cercle(centre, rayonVision(p.vision))] } });
    if (p.feu.portee_km > 0) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'feu' }, geometry: { type: 'LineString', coordinates: cercle(centre, p.feu.portee_km) } });
    if (estPoste(p)) { // un anneau par portée opérationnelle distincte des drones rattachés
      const portees = new Set(state.pieces.filter((q) => q.poste === p.id && exigePoste(q) && !q.detruit).map((q) => porteeLiaison(q, p)));
      for (const r of portees) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'liaison' }, geometry: { type: 'LineString', coordinates: cercle(centre, r) } });
    }
    if (rayonBrouillage(p) > 0) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'liaison' }, geometry: { type: 'LineString', coordinates: cercle(centre, rayonBrouillage(p)) } });
    if (p.dernier_deplacement) features.push({ type: 'Feature', properties: { ...proprietes, genre: 'trace' }, geometry: { type: 'LineString', coordinates: p.dernier_deplacement.trace } });
  }
  for (const p of montrees) { // les liens se voient toujours : c'est la structure de commandement, pas une portée
    if (!exigePoste(p)) continue;
    const l = etatLiaison(p, state.pieces);
    if (l.poste && !l.poste.detruit && estVisible(l.poste)) features.push({ type: 'Feature', properties: { camp: p.camp, id: p.id, genre: 'lien', perdu: !l.ok }, geometry: { type: 'LineString', coordinates: [[p.lng, p.lat], [l.poste.lng, l.poste.lat]] } });
  }
  return { type: 'FeatureCollection', features };
}

function rafraichirCarte() {
  const source = state.map && state.map.getSource(SOURCE_ID);
  if (source) source.setData(collection());
}

// ---------- marqueurs ----------
const modeleDe = (p) => state.catalogue.find((m) => m.id === p.type) || { nom: p.nom };

function styleMarqueur(p, el) {
  el.style.setProperty('--c', COULEURS[p.camp]);
  if (el.dataset.camp !== p.camp) { el.replaceChildren(symbole(modeleDe(p), p.camp, 22)); el.dataset.camp = p.camp; } // l'identité du symbole suit le camp
  el.title = `${p.nom} (${NOM_CAMP[p.camp]})${p.detruit ? ', détruit' : ''}`;
  el.classList.toggle('choisi', p.id === state.selection);
  el.classList.toggle('detruit', !!p.detruit);
}

function ajouterMarqueur(p) {
  const el = h('button', { class: 'pion', type: 'button' });
  styleMarqueur(p, el);
  el.addEventListener('click', (ev) => { ev.stopPropagation(); choisir(p.id); });
  const marqueur = new maplibre.Marker({ element: el, draggable: !estJoueur() }).setLngLat([p.lng, p.lat]).addTo(state.map);
  let depart = null;
  marqueur.on('dragstart', () => { depart = [p.lng, p.lat]; choisir(p.id); });
  marqueur.on('dragend', () => { const { lng, lat } = marqueur.getLngLat(); deplacer(p.id, depart, [lng, lat]); });
  state.marqueurs.set(p.id, marqueur);
}

function majMarqueurs() {
  for (const p of state.pieces) { const m = state.marqueurs.get(p.id); if (m) styleMarqueur(p, m.getElement()); }
}

// ---------- actions ----------
/** Rattache toute pièce qui exige un poste et n'en a pas au poste de son camp le plus proche, s'il la couvre. */
function relier() {
  const liens = lierAuto(state.pieces);
  if (!Object.keys(liens).length) return;
  state.pieces = state.pieces.map((p) => (liens[p.id] ? { ...p, poste: liens[p.id] } : p));
}

function creer(type, lngLat) {
  const modele = state.catalogue.find((m) => m.id === type);
  const numero = state.pieces.filter((p) => p.type === type).length + 1;
  const p = pieceDepuisModele(modele, { id: newId(), nom: `${modele.nom} ${numero}`, camp: state.camp, lng: lngLat.lng, lat: lngLat.lat });
  state.pieces = [...state.pieces, p];
  relier(); sauver(); ajouterMarqueur(p); choisir(p.id); signaler();
}

function deplacer(id, depart, arrivee) {
  const p = piece(id);
  if (!p || !depart) return;
  const km = distanceKm(depart, arrivee);
  maj(id, { lng: arrivee[0], lat: arrivee[1], dernier_deplacement: km < 0.001 ? null : { km, trace: [depart, arrivee] } });
  rafraichirCarte(); dessinerFiche(); signaler();
}

function supprimer(id) {
  const m = state.marqueurs.get(id);
  if (m) m.remove();
  state.marqueurs.delete(id);
  state.pieces = state.pieces.filter((p) => p.id !== id);
  relier(); sauver();
  if (state.selection === id) state.selection = null;
  rafraichirCarte(); dessinerFiche(); signaler();
}

function choisir(id) {
  state.selection = id;
  if (id) document.dispatchEvent(new CustomEvent('wg:selection', { detail: 'piece' }));
  document.dispatchEvent(new CustomEvent('wg:piece', { detail: { id } }));
  majMarqueurs(); rafraichirCarte(); dessinerFiche();
}

function armer(type) {
  state.arme = state.arme === type ? null : type;
  state.map.getCanvas().style.cursor = state.arme ? 'crosshair' : '';
  document.body.dataset.pieceArmee = state.arme ? 'oui' : 'non';
  if (state.arme) document.dispatchEvent(new CustomEvent('wg:outil', { detail: 'piece' }));
  dessinerBanque();
}

// ---------- panneau ----------
const fr = (x) => String(x).replace('.', ',');
const CIBLES_TEXTE = { fantassin: 'fantassins', vehicule: 'véhicules', artillerie: 'artilleries', brouilleur: 'brouilleurs', pilotes: 'équipes de pilotes', drone: 'drones' };
const CAUSES = { tir: 'tir', explosion: 'explosion', artillerie: 'tir d\'artillerie', endurance: 'endurance épuisée', brouillage: 'brouillage', poste: 'équipe de pilotes détruite', arbitre: 'décision de l\'arbitre' };
const texteCibles = (m) => (m.feu && m.feu.cibles && !m.feu.cibles.includes('*') ? m.feu.cibles.map((c) => CIBLES_TEXTE[c] || c).join(', ') : 'toutes les pièces');

/** Ce que fait le feu d'un modèle ou d'une pièce, en une phrase. */
function phraseFeu(m) {
  const mode = modeFeu(m);
  if (mode === 'direct') return `tir direct à ${fr(Math.round(m.feu.portee_km * 1000))} m`;
  if (mode === 'explosion') return `explose sur sa cible : ${fr(m.feu.zone_m2)} m² détruits (consommé)`;
  if (mode === 'zone') return `zone de ${fr(m.feu.rayon_m)} m à ${fr(m.feu.portee_km)} km (dispersion ${fr(m.feu.dispersion_m)} m)`;
  return 'aucun';
}
const phraseObservation = (m) => (m.vision.surface_km2 > 0 ? `${fr(m.vision.surface_km2)} km² au sol` : `${fr(m.vision.rayon_km)} km`);

function resume(m) {
  const lignes = [`Mouvement : ${fr(m.mouvement.min)} à ${fr(m.mouvement.max)} km/h`, `Observation : ${phraseObservation(m)}`, `Feu : ${phraseFeu(m)}`];
  if (modeFeu(m) !== 'aucun') lignes.push(`Détruit : ${texteCibles(m)}`);
  if (m.endurance_min > 0) lignes.push(`Endurance : ${fr(m.endurance_min)} min · portée ${fr(m.portee_op_km)} km`);
  if (m.brouillage) lignes.push(`Brouillage : zone de ${fr(m.brouillage.rayon_km)} km`);
  return lignes;
}

function dessinerBanque() {
  const boutons = Object.keys(NOM_CAMP).map((camp) => h('button', { class: 'camp', type: 'button', 'aria-pressed': String(state.camp === camp), style: `--c:${COULEURS[camp]}`,
    onclick: () => { state.camp = camp; dessinerBanque(); } }, NOM_CAMP[camp]));
  const cartes = state.catalogue.map((m) => h('button', { class: `modele${state.arme === m.id ? ' arme' : ''}`, type: 'button', onclick: () => armer(m.id), style: `--c:${COULEURS[state.camp]}` },
    h('span', { class: 'ico' }, symbole(m, state.camp, 22)), h('span', { class: 'txt' }, h('b', {}, m.nom), ...resume(m).map((l) => h('small', {}, l)))));
  const aide = state.arme ? 'Cliquez sur la carte pour poser. Échap pour arrêter.' : 'Choisissez un camp, une pièce, puis cliquez sur la carte.';
  $('banque').replaceChildren(h('div', { class: 'camps' }, boutons), ...cartes, h('p', { class: 'note' }, aide));
}

const $ = (id) => document.getElementById(id);

function champ(libelle, valeur, unite, onChange, props = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', value: String(valeur), ...props });
  input.addEventListener('input', () => onChange(input.value));
  return h('label', { class: 'champ' }, h('span', {}, libelle), input, unite ? h('em', {}, unite) : null);
}

function phraseDeplacement(p) {
  if (!p.dernier_deplacement) return 'Aucun déplacement. Faites glisser la pièce sur la carte.';
  const { rapide, lent } = dureesDeplacement(p.dernier_deplacement.km, p.mouvement.min, p.mouvement.max);
  return `${formatKm(p.dernier_deplacement.km)} · ${formatDuree(rapide)} à ${formatDuree(lent)} (${fr(p.mouvement.min)} à ${fr(p.mouvement.max)} km/h)`;
}

const km = (x) => x.toFixed(1).replace('.', ',');

/** Fiche : le poste d'un drone (à choisir parmi ceux qui le couvrent), ou les drones d'un poste. */
function sectionCommandement(p) {
  if (exigePoste(p)) {
    const l = etatLiaison(p, state.pieces);
    const equipes = state.pieces.filter((q) => estPoste(q) && !q.detruit && q.camp === p.camp);
    const options = [h('option', { value: '' }, '— aucune —'), ...equipes.map((q) => {
      const d = distanceKm([p.lng, p.lat], [q.lng, q.lat]);
      const hors = d > porteeLiaison(p, q) + 1e-9;
      return h('option', { value: q.id, selected: q.id === p.poste, disabled: hors && q.id !== p.poste }, `${q.nom} · ${km(d)} km${hors ? ' (hors de portée)' : ''}`);
    })];
    const choix = h('select', { onchange: (e) => { const r = attacherPoste(p.id, e.target.value || null); if (!r.ok) { alert(r.erreur); dessinerFiche(); } } }, ...options);
    const phrase = phraseLiaison(l);
    if (estJoueur()) return [h('h4', {}, 'Équipe de pilotes'), h('p', { class: phrase ? 'avert' : 'note' }, phrase ? `Liaison coupée : ${phrase}.` : `Liaison établie : ${km(l.distanceKm)} km sur ${km(l.porteeKm)} km au plus.`)]; // le rattachement est une décision de l'arbitre
    return [h('h4', {}, 'Équipe de pilotes'), h('label', { class: 'champ large' }, h('span', {}, 'Équipe'), choix),
      h('p', { class: phrase ? 'avert' : 'note' }, phrase ? `Liaison coupée : ${phrase}.` : `Liaison établie : ${km(l.distanceKm)} km sur ${km(l.porteeKm)} km au plus.`)];
  }
  if (estPoste(p)) {
    const drones = state.pieces.filter((q) => q.poste === p.id && exigePoste(q));
    return [h('h4', {}, 'Drones rattachés'),
      h('p', { class: 'note' }, drones.length ? `${drones.length} drone${drones.length > 1 ? 's' : ''} :` : 'Aucun. Une équipe peut en commander plusieurs.'),
      ...drones.map((q) => { const l = etatLiaison(q, state.pieces); return h('p', { class: l.ok ? 'note' : 'avert' }, `${q.nom} · ${l.distanceKm !== undefined ? `${km(l.distanceKm)} km sur ${km(l.porteeKm)}` : '—'}${l.ok ? '' : ' (liaison coupée)'}`); })];
  }
  return [];
}

/** Fiche : le feu de la pièce, avec les champs propres à son mode. */
function sectionFeu(p, miseAJour) {
  const mode = modeFeu(p);
  const feu = () => piece(p.id).feu;
  if (mode === 'aucun') return [h('h4', {}, 'Feu'), h('p', { class: 'note' }, 'Aucun feu.')];
  const champs = mode === 'direct' ? [champ('Portée', Math.round(p.feu.portee_km * 1000), 'm', (v) => miseAJour({ feu: { ...feu(), portee_km: nombre(v, 0, 5e6, p.feu.portee_km * 1000) / 1000 } }))]
    : mode === 'explosion' ? [champ('Zone détruite', p.feu.zone_m2, 'm²', (v) => miseAJour({ feu: { ...feu(), zone_m2: nombre(v, 0, 1e9, p.feu.zone_m2) } }))]
      : [h('div', { class: 'duo' }, champ('Portée', p.feu.portee_km, 'km', (v) => miseAJour({ feu: { ...feu(), portee_km: nombre(v, 0, 5000, p.feu.portee_km) } })),
        champ('Rayon', p.feu.rayon_m, 'm', (v) => miseAJour({ feu: { ...feu(), rayon_m: nombre(v, 0, 1e6, p.feu.rayon_m) } }))),
      champ('Dispersion', p.feu.dispersion_m, 'm', (v) => miseAJour({ feu: { ...feu(), dispersion_m: nombre(v, 0, 1e6, p.feu.dispersion_m) } }))];
  return [h('h4', {}, 'Feu'), ...champs, h('p', { class: 'note' }, `Détruit : ${texteCibles(p)}.`)];
}

/** Fiche : ce qui est propre aux drones (endurance, portée opérationnelle, état de vol) et aux brouilleurs. */
function sectionSpecifique(p, miseAJour) {
  const sorties = [];
  if (estDrone(p)) {
    sorties.push(h('h4', {}, 'Vol'),
      champ('Endurance', p.endurance_min, 'min', (v) => { const n = nombre(v, 1, 1e4, p.endurance_min); miseAJour({ endurance_min: n, endurance_restante_min: Math.min(enduranceRestante(piece(p.id)), n) }); }),
      champ('Portée', p.portee_op_km, 'km', (v) => miseAJour({ portee_op_km: nombre(v, 1, 5000, p.portee_op_km) })),
      h('p', { class: 'note' }, enVol(p) ? `En vol · endurance restante ${fr(Math.round(enduranceRestante(p) * 10) / 10)} min.` : 'Au sol auprès de son équipe de pilotes.'));
    if (p.immunise_brouillage) sorties.push(h('p', { class: 'note' }, 'Insensible au brouillage (fibre optique).'));
  }
  if (p.brouillage) sorties.push(h('h4', {}, 'Brouillage'), champ('Zone', p.brouillage.rayon_km, 'km', (v) => miseAJour({ brouillage: { rayon_km: nombre(v, 0, 1000, p.brouillage.rayon_km) } })));
  return sorties;
}

/** Décision de l'arbitre : forcer ou annuler la destruction d'une pièce. */
function boutonsArbitre(p) {
  if (p.detruit) return [h('p', { class: 'avert' }, `Détruit (${CAUSES[p.cause_destruction] || 'cause inconnue'}).`),
    h('button', { type: 'button', onclick: () => restaurer(p.id) }, 'Rétablir la pièce')];
  return [h('button', { type: 'button', onclick: () => detruire(p.id, 'arbitre') }, 'Détruire la pièce')];
}

/** Fiche d'un joueur : ce qu'il peut savoir de la pièce, sans rien à modifier. */
function fichePublique(p) {
  const propre = p.camp === role.camp;
  const lignes = [h('h4', {}, p.nom), h('p', { class: 'note' }, `${NOM_CAMP[p.camp]}${p.detruit ? ' · détruite' : ''}${propre ? '' : ' · détectée'}`)];
  if (propre) {
    lignes.push(h('p', { class: 'note' }, resume(p).join(' · ')));
    if (estDrone(p)) lignes.push(h('p', { class: 'note' }, enVol(p) ? `En vol · endurance restante ${fr(Math.round(enduranceRestante(p) * 10) / 10)} min.` : 'Au sol auprès de son équipe de pilotes.'));
    lignes.push(...sectionCommandement(p));
  } else lignes.push(h('p', { class: 'note' }, `Position : ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`));
  return lignes;
}

function dessinerFiche() {
  const boite = $('fiche');
  const p = piece(state.selection);
  if (!p) { boite.replaceChildren(h('p', { class: 'note' }, 'Aucune pièce sélectionnée.')); return; }
  if (estJoueur()) { boite.replaceChildren(...fichePublique(p)); return; }
  const modele = state.catalogue.find((m) => m.id === p.type);
  const deplacement = h('p', { class: 'note' }, phraseDeplacement(p));
  const miseAJour = (patch) => { maj(p.id, patch); const q = piece(p.id); deplacement.textContent = phraseDeplacement(q); rafraichirCarte(); majMarqueurs(); };
  const camps = h('div', { class: 'camps' }, ...Object.keys(NOM_CAMP).map((camp) => h('button', { class: 'camp', type: 'button', 'aria-pressed': String(p.camp === camp), style: `--c:${COULEURS[camp]}`,
    onclick: () => { maj(p.id, { camp, poste: null }); relier(); sauver(); majMarqueurs(); rafraichirCarte(); dessinerFiche(); signaler(); } }, NOM_CAMP[camp])));
  boite.replaceChildren(...[
    champ('Nom', p.nom, '', (v) => { maj(p.id, { nom: v.slice(0, 60) }); majMarqueurs(); }, { class: 'large' }), camps,
    h('h4', {}, 'Mouvement'),
    h('div', { class: 'duo' },
      champ('Min', p.mouvement.min, 'km/h', (v) => miseAJour({ mouvement: { ...piece(p.id).mouvement, min: nombre(v, 0, 5000, p.mouvement.min) } })),
      champ('Max', p.mouvement.max, 'km/h', (v) => miseAJour({ mouvement: { ...piece(p.id).mouvement, max: nombre(v, 0, 5000, p.mouvement.max) } }))),
    deplacement,
    ...sectionFeu(p, miseAJour),
    h('h4', {}, 'Observation'),
    p.vision.surface_km2 !== undefined
      ? champ('Surface', p.vision.surface_km2, 'km²', (v) => { const n = nombre(v, 0, 1e6, p.vision.surface_km2); miseAJour({ vision: { surface_km2: n, rayon_km: rayonDeSurfaceKm(n) } }); })
      : champ('Rayon', p.vision.rayon_km, 'km', (v) => miseAJour({ vision: { rayon_km: nombre(v, 0, 5000, p.vision.rayon_km) } })),
    ...sectionSpecifique(p, miseAJour),
    ...sectionCommandement(p),
    modele && modele.avertissement ? h('p', { class: 'note' }, modele.avertissement) : null,
    h('p', { class: 'note' }, `Position : ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`),
    ...boutonsArbitre(p),
    h('button', { class: 'danger', type: 'button', onclick: () => supprimer(p.id) }, 'Supprimer la pièce')].filter(Boolean));
}

function dessinerOptions() {
  const choix = [['selection', 'Pièce sélectionnée'], ['toutes', 'Toutes les pièces'], ['aucune', 'Aucune']];
  $('portees').replaceChildren(...choix.map(([valeur, libelle]) => h('label', { class: 'opt' },
    h('input', { type: 'radio', name: 'portees', value: valeur, checked: state.portees === valeur, onchange: () => { state.portees = valeur; rafraichirCarte(); } }), h('span', {}, libelle))),
  h('button', { class: 'danger', type: 'button', 'data-arbitre': '', onclick: () => { if (state.pieces.length && confirm('Retirer toutes les pièces de la carte ?')) [...state.pieces].forEach((p) => supprimer(p.id)); } }, 'Tout effacer'));
}

// ---------- interface pour les consignes ----------
const estVisible = (p) => !state.visibles || state.visibles.has(p.id);
function signaler() { document.dispatchEvent(new CustomEvent('wg:pieces')); }

/** Crée plusieurs pièces d'un coup (assistant). `specs` : { vid, type, camp, lng, lat, nom }. Rend { vid: id réel }. */
export function creerPieces(specs) {
  const ids = {};
  for (const sp of specs) {
    const modele = state.catalogue.find((m) => m.id === sp.type);
    if (!modele) continue;
    const p = pieceDepuisModele(modele, { id: newId(), nom: sp.nom, camp: sp.camp, lng: sp.lng, lat: sp.lat });
    state.pieces = [...state.pieces, p];
    ids[sp.vid] = p.id;
  }
  relier();
  for (const id of Object.values(ids)) ajouterMarqueur(piece(id));
  sauver(); rafraichirCarte(); signaler();
  return ids;
}

/** Rattache un drone à une équipe de pilotes (ou le détache avec null). Rend { ok, erreur } : l'équipe doit être du même camp, vivante, et couvrir le drone. */
export function attacherPoste(id, posteId) {
  const p = piece(id);
  if (!p || !exigePoste(p)) return { ok: false, erreur: 'Cette pièce n\'a pas besoin d\'équipe de pilotes.' };
  if (posteId) {
    const q = piece(posteId);
    if (!q || !estPoste(q)) return { ok: false, erreur: 'Ce n\'est pas une équipe de pilotes.' };
    if (q.camp !== p.camp) return { ok: false, erreur: 'L\'équipe est d\'un autre camp.' };
    if (q.detruit) return { ok: false, erreur: 'L\'équipe est détruite.' };
    const d = distanceKm([p.lng, p.lat], [q.lng, q.lat]);
    if (d > porteeLiaison(p, q) + 1e-9) return { ok: false, erreur: `L'équipe est à ${d.toFixed(1).replace('.', ',')} km, la portée de ce drone est de ${porteeLiaison(p, q)} km.` };
  }
  maj(id, { poste: posteId || null });
  rafraichirCarte(); dessinerFiche(); signaler();
  return { ok: true, erreur: null };
}

/**
 * Vue d'un joueur : remplace les pièces par celles que le serveur lui envoie (les siennes en entier, les adverses détectées en version réduite,
 * complétées ici avec le catalogue). Les marqueurs sont mis à jour sur place.
 */
export function remplacerPieces(liste) {
  const cle = JSON.stringify(liste);
  if (cle === state.cleVue) return;
  state.cleVue = cle;
  const completes = liste.map((p) => {
    const m = state.catalogue.find((x) => x.id === p.type);
    return m ? { ...pieceDepuisModele(m, { id: p.id, nom: p.nom, camp: p.camp, lng: p.lng, lat: p.lat }), ...p } : p;
  });
  const ids = new Set(completes.map((p) => p.id));
  for (const [id, mq] of state.marqueurs) if (!ids.has(id)) { mq.remove(); state.marqueurs.delete(id); }
  const avant = state.pieces.map((p) => `${p.id}:${p.detruit}`).join();
  state.pieces = completes;
  for (const p of completes) {
    const mq = state.marqueurs.get(p.id);
    if (mq) { mq.setLngLat([p.lng, p.lat]); styleMarqueur(p, mq.getElement()); } else ajouterMarqueur(p);
  }
  if (state.selection && !ids.has(state.selection)) state.selection = null;
  rafraichirCarte(); dessinerFiche();
  if (avant !== completes.map((p) => `${p.id}:${p.detruit}`).join()) signaler();
}

/** Une pièce détruite reste sur la carte (grisée) mais ne voit, ne tire et ne se déplace plus. */
export function detruire(id, cause = 'arbitre') {
  const p = piece(id);
  if (!p) return;
  const perdus = estPoste(p) && !p.detruit ? affilies(p, state.pieces).map((d) => d.id) : []; // sans équipe, plus aucun drone ne peut être piloté : ils sont perdus avec elle
  maj(id, { detruit: true, cause_destruction: cause });
  for (const d of perdus) maj(d, { detruit: true, cause_destruction: 'poste' });
  majMarqueurs(); rafraichirCarte(); dessinerFiche(); signaler();
  if (perdus.length) document.dispatchEvent(new CustomEvent('wg:cascade', { detail: { posteId: id, droneIds: perdus } }));
}

/** Modifie des champs d'une pièce par programme (état de vol, endurance...) sans toucher à la fiche. */
export function modifier(id, patch) { if (piece(id)) maj(id, patch); }
export const piecesRetirees = () => [...state.retirees];

export function restaurer(id) {
  if (!piece(id) || !piece(id).detruit) return;
  maj(id, { detruit: false, cause_destruction: null });
  majMarqueurs(); rafraichirCarte(); dessinerFiche(); signaler();
}

export const catalogue = () => state.catalogue.map((m) => ({ ...m }));
export const listerPieces = () => state.pieces.map((p) => ({ ...p }));
export const pieceChoisie = () => state.selection;
export const choisirPiece = (id) => choisir(id);

/** Déplace une pièce par programme (exécution d'une consigne). `trace` garde le point de départ pour le tracé. */
export function positionner(id, [lng, lat], trace = null) {
  const p = piece(id);
  if (!p) return;
  const depart = trace || [p.lng, p.lat];
  maj(id, { lng, lat, dernier_deplacement: trace ? { km: distanceKm(depart, [lng, lat]), trace: [depart, [lng, lat]] } : p.dernier_deplacement });
  const m = state.marqueurs.get(id);
  if (m) m.setLngLat([lng, lat]);
}

/** Limite l'affichage aux pièces dont l'identifiant est dans `ids` (point de vue d'un camp). null = tout voir. */
export function appliquerVisibilite(ids) {
  state.visibles = ids;
  for (const p of state.pieces) { const m = state.marqueurs.get(p.id); if (m) m.getElement().style.display = estVisible(p) ? '' : 'none'; }
  rafraichirCarte();
}

export function rafraichir() { rafraichirCarte(); dessinerFiche(); }
/** Redessine seulement les couches (portées, liens), sans toucher à la fiche : utilisable à chaque pas d'horloge. */
export const rafraichirPortees = () => rafraichirCarte();

// ---------- montage ----------
export async function monter(map) {
  state.map = map;
  const reponse = await fetch('/static/pieces.json');
  state.catalogue = (await reponse.json()).pieces;
  const migration = migrerPieces(estJoueur() ? [] : charger(), state.catalogue); // pièces de l'ancien catalogue : reconstruites ou retirées
  state.pieces = migration.pieces; state.retirees = migration.retirees;
  if (!estJoueur() && (migration.retirees.length || migration.pieces.some((p, i) => p !== charger()[i]))) sauver();
  for (const p of state.pieces) ajouterMarqueur(p);
  map.on('click', (e) => {
    if (document.body.dataset.pointage === 'oui') return; // une consigne est en cours de pointage sur la carte
    if (state.arme && !estJoueur()) creer(state.arme, e.lngLat); else if (state.selection) choisir(null);
  });
  document.addEventListener('keydown', (e) => {
    const saisie = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape' && state.arme) armer(state.arme);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection && !saisie && !estJoueur()) { e.preventDefault(); supprimer(state.selection); }
  });
  document.addEventListener('wg:outil', (e) => { if (e.detail === 'dessin' && state.arme) armer(state.arme); });
  document.addEventListener('wg:selection', (e) => {
    if (e.detail === 'dessin' && state.selection) { state.selection = null; majMarqueurs(); rafraichirCarte(); dessinerFiche(); }
  });
  dessinerBanque(); dessinerFiche(); dessinerOptions(); rafraichirCarte();
}
