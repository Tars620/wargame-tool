// Symbole d'un drone selon la norme (APP-6 / MIL-STD-2525) : le chevron des aéronefs sans équipage dans le cadre de l'unité (rectangle ami, losange hostile),
// avec le type de drone écrit dans le cadre. Le cadre vient de milsymbol ; le chevron est celui de son symbole d'aéronef sans équipage (entité 110300).
export const TYPES_DRONE = { 'drone-isr': 'ISR', 'drone-owa': 'OWA', 'drone-filoguide': 'FILO' };
export const estModeleDrone = (modele) => Boolean(modele && TYPES_DRONE[modele.id]);

const IDENTITE = { bleu: '3', rouge: '6' }; // 3 = ami (rectangle bleu), 6 = hostile (losange rouge)
const CADRE_UNITE = '10'; // ensemble « unité terrestre » : le cadre seul, sans icône
const CHEVRON = '<path d="m 60,84 40,20 40,-20 0,8 -40,25 -40,-25 z" transform="translate(0 -11)" fill="black"/>'; // dessin du chevron de milsymbol, remonté pour laisser la place au texte
const texte = (t) =>
  `<text x="100" y="${t.length > 3 ? 143 : 141}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${t.length > 3 ? 21 : 24}" fill="black">${t}</text>`;

/** Élément SVG du symbole d'un drone de ce modèle pour ce camp, à la taille `taille` de milsymbol. */
export function iconeDrone(modele, camp, taille = 34) {
  const type = TYPES_DRONE[modele.id];
  const code = `100${IDENTITE[camp] || '4'}${CADRE_UNITE}00${'00'}${'000000'}0000`;
  const cadre = new window.ms.Symbol(code, { size: taille }).asSVG(); // chaîne produite par milsymbol, complétée par du texte constant
  const svg = new DOMParser().parseFromString(cadre.replace('</svg>', `${CHEVRON}${texte(type)}</svg>`), 'image/svg+xml').documentElement;
  svg.setAttribute('class', `drone drone-${type.toLowerCase()}`);
  svg.setAttribute('aria-hidden', 'true');
  return document.importNode(svg, true);
}
