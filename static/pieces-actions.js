// Actions sur les pièces : créer, déplacer, supprimer, détruire, rattacher, choisir. Chaque action met à jour l'état puis la carte et la fiche.
import { distanceKm } from './geo.js';
import { affilies, estPoste, exigePoste, lierAuto, porteeLiaison } from './moteur.js';
import { pieceDepuisModele } from './catalogue.js';
import { maj, newId, piece, sauver, signaler, estVisible, state } from './pieces-etat.js';
import { ajouterMarqueur, majMarqueurs, rafraichirCarte, styleMarqueur } from './pieces-carte.js';

/** Rattache toute pièce qui exige un poste et n'en a pas au poste de son camp le plus proche, s'il la couvre. */
export function relier() {
  const liens = lierAuto(state.pieces);
  if (!Object.keys(liens).length) return;
  state.pieces = state.pieces.map((p) => (liens[p.id] ? { ...p, poste: liens[p.id] } : p));
}

export function creer(type, lngLat) {
  const modele = state.catalogue.find((m) => m.id === type);
  const numero = state.pieces.filter((p) => p.type === type).length + 1;
  const p = pieceDepuisModele(modele, { id: newId(), nom: `${modele.nom} ${numero}`, camp: state.camp, lng: lngLat.lng, lat: lngLat.lat });
  state.pieces = [...state.pieces, p];
  relier();
  sauver();
  ajouterMarqueur(p);
  choisir(p.id);
  signaler();
}

export function deplacer(id, depart, arrivee) {
  const p = piece(id);
  if (!p || !depart) return;
  const km = distanceKm(depart, arrivee);
  maj(id, { lng: arrivee[0], lat: arrivee[1], dernier_deplacement: km < 0.001 ? null : { km, trace: [depart, arrivee] } });
  rafraichirCarte();
  state.redessiner.fiche();
  signaler();
}

export function supprimer(id) {
  const m = state.marqueurs.get(id);
  if (m) m.remove();
  state.marqueurs.delete(id);
  state.pieces = state.pieces.filter((p) => p.id !== id);
  relier();
  sauver();
  if (state.selection === id) state.selection = null;
  rafraichirCarte();
  state.redessiner.fiche();
  signaler();
}

export function choisir(id) {
  state.selection = id;
  if (id) document.dispatchEvent(new CustomEvent('wg:selection', { detail: 'piece' }));
  document.dispatchEvent(new CustomEvent('wg:piece', { detail: { id } }));
  majMarqueurs();
  rafraichirCarte();
  state.redessiner.fiche();
}

export function armer(type) {
  state.arme = state.arme === type ? null : type;
  state.map.getCanvas().style.cursor = state.arme ? 'crosshair' : '';
  document.body.dataset.pieceArmee = state.arme ? 'oui' : 'non';
  if (state.arme) document.dispatchEvent(new CustomEvent('wg:outil', { detail: 'piece' }));
  state.redessiner.banque();
}

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
  sauver();
  rafraichirCarte();
  signaler();
  return ids;
}

/** Rattache un drone à une équipe de pilotes (ou le détache avec null). Rend { ok, erreur } : l'équipe doit être du même camp, vivante, et couvrir le drone. */
export function attacherPoste(id, posteId) {
  const p = piece(id);
  if (!p || !exigePoste(p)) return { ok: false, erreur: "Cette pièce n'a pas besoin d'équipe de pilotes." };
  if (posteId) {
    const q = piece(posteId);
    if (!q || !estPoste(q)) return { ok: false, erreur: "Ce n'est pas une équipe de pilotes." };
    if (q.camp !== p.camp) return { ok: false, erreur: "L'équipe est d'un autre camp." };
    if (q.detruit) return { ok: false, erreur: "L'équipe est détruite." };
    const d = distanceKm([p.lng, p.lat], [q.lng, q.lat]);
    if (d > porteeLiaison(p, q) + 1e-9)
      return { ok: false, erreur: `L'équipe est à ${d.toFixed(1).replace('.', ',')} km, la portée de ce drone est de ${porteeLiaison(p, q)} km.` };
  }
  maj(id, { poste: posteId || null });
  rafraichirCarte();
  state.redessiner.fiche();
  signaler();
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
  for (const [id, mq] of state.marqueurs)
    if (!ids.has(id)) {
      mq.remove();
      state.marqueurs.delete(id);
    }
  const avant = state.pieces.map((p) => `${p.id}:${p.detruit}`).join();
  state.pieces = completes;
  for (const p of completes) {
    const mq = state.marqueurs.get(p.id);
    if (mq) {
      mq.setLngLat([p.lng, p.lat]);
      styleMarqueur(p, mq.getElement());
    } else ajouterMarqueur(p);
  }
  if (state.selection && !ids.has(state.selection)) state.selection = null;
  rafraichirCarte();
  state.redessiner.fiche();
  if (avant !== completes.map((p) => `${p.id}:${p.detruit}`).join()) signaler();
}

/** Une pièce détruite reste sur la carte (grisée) mais ne voit, ne tire et ne se déplace plus. */
export function detruire(id, cause = 'arbitre') {
  const p = piece(id);
  if (!p) return;
  const perdus = estPoste(p) && !p.detruit ? affilies(p, state.pieces).map((d) => d.id) : []; // sans équipe, plus aucun drone ne peut être piloté : ils sont perdus avec elle
  maj(id, { detruit: true, cause_destruction: cause });
  for (const d of perdus) maj(d, { detruit: true, cause_destruction: 'poste' });
  majMarqueurs();
  rafraichirCarte();
  state.redessiner.fiche();
  signaler();
  if (perdus.length) document.dispatchEvent(new CustomEvent('wg:cascade', { detail: { posteId: id, droneIds: perdus } }));
}

/** Modifie des champs d'une pièce par programme (état de vol, endurance...) sans toucher à la fiche. */
/** Remet le pion à jour (vol, cap, mouvement) : sans cela un drone qui décolle ou avance garde son apparence de drone posé. */
function restyler(id) {
  const m = state.marqueurs.get(id);
  const p = piece(id);
  if (m && p) styleMarqueur(p, m.getElement());
}

export function modifier(id, patch) {
  if (!piece(id)) return;
  maj(id, patch);
  restyler(id);
}
export const piecesRetirees = () => [...state.retirees];

export function restaurer(id) {
  if (!piece(id) || !piece(id).detruit) return;
  maj(id, { detruit: false, cause_destruction: null });
  majMarqueurs();
  rafraichirCarte();
  state.redessiner.fiche();
  signaler();
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
  restyler(id);
}

/** Limite l'affichage aux pièces dont l'identifiant est dans `ids` (point de vue d'un camp). null = tout voir. */
export function appliquerVisibilite(ids) {
  const cle = `${ids ? [...ids].sort().join(',') : '*'}|${state.pieces.map((p) => p.id).join(',')}`;
  if (cle === state.visiblesCle) return; // rien de changé : ni pions ni carte à retoucher
  state.visiblesCle = cle;
  state.visibles = ids;
  for (const p of state.pieces) {
    const m = state.marqueurs.get(p.id);
    if (m) m.getElement().style.display = estVisible(p) ? '' : 'none';
  }
  rafraichirCarte();
}

export function rafraichir() {
  rafraichirCarte();
  state.redessiner.fiche();
}
/** Redessine seulement les couches (portées, liens), sans toucher à la fiche : utilisable à chaque pas d'horloge. */
export const rafraichirPortees = () => rafraichirCarte();

// Les pions de la carte appellent ces actions par l'état (pas d'import circulaire).
state.surChoix = choisir;
state.surDeplacement = deplacer;
