// Pièces : point d'entrée. L'état, la carte, les actions et le panneau vivent dans pieces-*.js ; les autres modules importent d'ici.
import { estJoueur } from './role.js';
import { migrerPieces } from './catalogue.js';
import { SOURCE_ID, charger, sauver, state } from './pieces-etat.js';
import { ajouterMarqueur, majMarqueurs, rafraichirCarte } from './pieces-carte.js';
import { armer, choisir, creer, supprimer } from './pieces-actions.js';
import { dessinerBanque, dessinerFiche, dessinerOptions } from './pieces-fiche.js';

export { SOURCE_ID } from './pieces-etat.js';
export { collection, layerSpecs } from './pieces-carte.js';
export { appliquerVisibilite, attacherPoste, catalogue, choisirPiece, creerPieces, detruire, listerPieces, modifier, pieceChoisie, piecesRetirees, positionner,
  rafraichir, rafraichirPortees, remplacerPieces, restaurer } from './pieces-actions.js';

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
