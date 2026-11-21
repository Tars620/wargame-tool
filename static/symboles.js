// Symboles militaires APP-6D / MIL-STD-2525D, dessinés par milsymbol (MIT, global `ms`).
const IDENTITE = { bleu: '3', rouge: '6' }; // 3 = ami (bleu), 6 = hostile (rouge)
const IDENTITE_INCONNUE = '4';              // 4 = inconnu

/** Code SIDC à 20 chiffres d'un modèle de pièce pour un camp : version, contexte, identité, ensemble, statut, entité. */
export function sidc(modele, camp) {
  const { jeu, entite } = modele.sidc;
  return `100${IDENTITE[camp] || IDENTITE_INCONNUE}${jeu}0000${entite}0000`;
}

/** Élément DOM du symbole ; à défaut de bibliothèque ou de code, deux lettres du nom. */
export function symbole(modele, camp, taille = 24) {
  const el = document.createElement('span');
  el.className = 'symbole';
  if (window.ms && modele.sidc) el.append(new window.ms.Symbol(sidc(modele, camp), { size: taille }).asDOM());
  else el.textContent = (modele.nom || '?').slice(0, 2).toUpperCase();
  return el;
}
