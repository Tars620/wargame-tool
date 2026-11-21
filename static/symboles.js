import { estModeleDrone, iconeDrone } from './drones.js';

const COULEURS_CAMP = { bleu: '#4c8dff', rouge: '#e5484d' };

// Symboles militaires APP-6D / MIL-STD-2525D, dessinés par milsymbol (MIT, global `ms`).
const IDENTITE = { bleu: '3', rouge: '6' }; // 3 = ami (bleu), 6 = hostile (rouge)
const IDENTITE_INCONNUE = '4'; // 4 = inconnu

/** Code SIDC à 20 chiffres d'un modèle de pièce pour un camp : version, contexte, identité, ensemble, statut, entité. */
export function sidc(modele, camp) {
  const { jeu, entite, etat_major: etatMajor } = modele.sidc;
  return `100${IDENTITE[camp] || IDENTITE_INCONNUE}${jeu}0${etatMajor ? '2' : '0'}00${entite}0000`; // chiffre 8 : 2 = état-major (mât sur le symbole)
}

/** Élément DOM du symbole ; à défaut de bibliothèque ou de code, deux lettres du nom. */
export function symbole(modele, camp, taille = 24) {
  const el = document.createElement('span');
  el.className = 'symbole';
  if (estModeleDrone(modele)) {
    el.style.setProperty('--c', COULEURS_CAMP[camp] || '#9a9aa2'); // les drones ont leur propre silhouette par type
    el.append(iconeDrone(modele, Math.max(taille, 28)));
  } else if (window.ms && modele.sidc) el.append(new window.ms.Symbol(sidc(modele, camp), { size: taille }).asDOM());
  else el.textContent = (modele.nom || '?').slice(0, 2).toUpperCase();
  return el;
}
