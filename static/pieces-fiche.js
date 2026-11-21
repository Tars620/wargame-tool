// Panneau des pièces : banque (choix et pose), fiche d'une pièce (réglages, feu, drones, destruction) et options d'affichage.
import { distanceKm, formatDuree, dureesDeplacement, formatKm } from './geo.js';
import { symbole } from './symboles.js';
import { estJoueur, role } from './role.js';
import { estPoste, exigePoste, etatLiaison, phraseLiaison, porteeLiaison } from './moteur.js';
import { enVol, enduranceRestante, estDrone, modeFeu, rayonDeSurfaceKm } from './regles.js';
import { h, $ } from './ui.js';
import { COULEURS, NOM_CAMP, maj, nombre, piece, sauver, signaler, state } from './pieces-etat.js';
import { majMarqueurs, rafraichirCarte } from './pieces-carte.js';
import { armer, attacherPoste, detruire, relier, restaurer, supprimer } from './pieces-actions.js';

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

export function dessinerBanque() {
  const boutons = Object.keys(NOM_CAMP).map((camp) => h('button', { class: 'camp', type: 'button', 'aria-pressed': String(state.camp === camp), style: `--c:${COULEURS[camp]}`,
    onclick: () => { state.camp = camp; dessinerBanque(); } }, NOM_CAMP[camp]));
  const cartes = state.catalogue.map((m) => h('button', { class: `modele${state.arme === m.id ? ' arme' : ''}`, type: 'button', onclick: () => armer(m.id), style: `--c:${COULEURS[state.camp]}` },
    h('span', { class: 'ico' }, symbole(m, state.camp, 22)), h('span', { class: 'txt' }, h('b', {}, m.nom), ...resume(m).map((l) => h('small', {}, l)))));
  const aide = state.arme ? 'Cliquez sur la carte pour poser. Échap pour arrêter.' : 'Choisissez un camp, une pièce, puis cliquez sur la carte.';
  $('banque').replaceChildren(h('div', { class: 'camps' }, boutons), ...cartes, h('p', { class: 'note' }, aide));
}

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
export function fichePublique(p) {
  const propre = p.camp === role.camp;
  const lignes = [h('h4', {}, p.nom), h('p', { class: 'note' }, `${NOM_CAMP[p.camp]}${p.detruit ? ' · détruite' : ''}${propre ? '' : ' · détectée'}`)];
  if (propre) {
    lignes.push(h('p', { class: 'note' }, resume(p).join(' · ')));
    if (estDrone(p)) lignes.push(h('p', { class: 'note' }, enVol(p) ? `En vol · endurance restante ${fr(Math.round(enduranceRestante(p) * 10) / 10)} min.` : 'Au sol auprès de son équipe de pilotes.'));
    lignes.push(...sectionCommandement(p));
  } else lignes.push(h('p', { class: 'note' }, `Position : ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`));
  return lignes;
}

export function dessinerFiche() {
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

export function dessinerOptions() {
  const choix = [['selection', 'Pièce sélectionnée'], ['toutes', 'Toutes les pièces'], ['aucune', 'Aucune']];
  $('portees').replaceChildren(...choix.map(([valeur, libelle]) => h('label', { class: 'opt' },
    h('input', { type: 'radio', name: 'portees', value: valeur, checked: state.portees === valeur, onchange: () => { state.portees = valeur; rafraichirCarte(); } }), h('span', {}, libelle))),
  h('button', { class: 'danger', type: 'button', 'data-arbitre': '', onclick: () => { if (state.pieces.length && confirm('Retirer toutes les pièces de la carte ?')) [...state.pieces].forEach((p) => supprimer(p.id)); } }, 'Tout effacer'));
}

// L'état appelle ces redessins par ses liens (pas d'import circulaire).
state.redessiner = { fiche: dessinerFiche, banque: dessinerBanque };
