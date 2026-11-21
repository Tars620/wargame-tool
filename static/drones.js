// Silhouettes de drones (une par type) : ISR = quadricoptère à objectif, OWA = aile delta à ogive, filoguidé = petit quadricoptère à bobine de fil.
// Dessinées vers le haut (nord) ; l'orientation de vol les fait tourner. Couleur du camp par --c.
const CORPS = '<g stroke="#ffffff" stroke-width="1.1" stroke-linejoin="round" fill="var(--c)">';
const ROTOR = (x, y, r = 6) => `<g class="rotor" fill="none" stroke="var(--c)" stroke-width="1.2" opacity=".95"><circle cx="${x}" cy="${y}" r="${r}"/><path d="M${x - r} ${y}H${x + r}M${x} ${y - r}V${y + r}" stroke-width=".9"/></g>`;

const FORMES = {
  // observation : quatre rotors, corps large, objectif sous le nez
  isr: `${ROTOR(9, 9)}${ROTOR(31, 9)}${ROTOR(9, 31)}${ROTOR(31, 31)}
    <path d="M9 9L31 31M31 9L9 31" stroke="var(--c)" stroke-width="2.4"/>
    ${CORPS}<rect x="14.5" y="13" width="11" height="14" rx="3"/></g>
    <circle cx="20" cy="15.5" r="3.2" fill="#0b0b0c" stroke="#fff" stroke-width="1"/><circle cx="20" cy="15.5" r="1.1" fill="#7fe3ff"/>`,
  // attaque : aile delta effilée, ogive au nez, dérives à l'arrière
  owa: `${CORPS}<path d="M20 2L33 33L20 28L7 33Z"/></g>
    <path d="M20 2L24 12H16Z" fill="#fff" opacity=".95"/><path d="M20 28L20 36" stroke="#fff" stroke-width="1.6"/>
    <path d="M7 33L4 37M33 33L36 37" stroke="var(--c)" stroke-width="2.2" stroke-linecap="round"/>
    <circle class="helice" cx="20" cy="37" r="2.6" fill="none" stroke="#fff" stroke-width="1"/>`,
  // filoguidé : petit quadricoptère vu de face, bobine de fil à l'arrière
  filoguide: `${ROTOR(11, 11, 5)}${ROTOR(29, 11, 5)}${ROTOR(11, 27, 5)}${ROTOR(29, 27, 5)}
    <path d="M11 11L29 27M29 11L11 27" stroke="var(--c)" stroke-width="2"/>
    ${CORPS}<rect x="16" y="14" width="8" height="12" rx="2"/></g>
    <circle cx="20" cy="31.5" r="3.6" fill="#0b0b0c" stroke="var(--c)" stroke-width="1.4"/><circle cx="20" cy="31.5" r="1.2" fill="var(--c)"/>
    <path d="M20 35.5V40" stroke="var(--c)" stroke-width="1" stroke-dasharray="1.4 1.6"/>`
};

export const TYPES_DRONE = { 'drone-isr': 'isr', 'drone-owa': 'owa', 'drone-filoguide': 'filoguide' };
export const estModeleDrone = (modele) => Boolean(modele && TYPES_DRONE[modele.id]);

/** Élément SVG d'un drone de ce modèle, à `taille` pixels. */
export function iconeDrone(modele, taille = 34) {
  const type = TYPES_DRONE[modele.id];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('width', String(taille));
  svg.setAttribute('height', String(taille));
  svg.setAttribute('class', `drone drone-${type}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = FORMES[type]; // chaînes constantes ci-dessus : aucune donnée saisie
  return svg;
}
