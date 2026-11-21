// Zones tenues, contestées, gagnées et perdues. Une zone « tenue » par un camp est ce que ses pièces vivantes observent (disques d'observation réunis).
// « Gagnée » / « perdue » se mesurent depuis une situation de référence que l'on fixe quand on veut ; elle reste dans ce navigateur.
// Un joueur ne calcule que son propre camp : l'adversaire n'apparaît jamais ici (brouillard de guerre).
import { cercle } from './geo.js';
import { enVol, estDrone, rayonVision } from './regles.js';
import { estJoueur, role } from './role.js';
import { listerPieces } from './pieces.js';
import { state as etatPieces } from './pieces-etat.js';
import { ecrireJson, h, lireJson, sourceGeojson } from './ui.js';

export const SOURCE_CONTROLE = 'controle';
const STOCK = 'wg.controle.v1';
const PERIODE_MS = 1000;
const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d', contestee: '#f5c542', gagnee: '#2fbf71', perdue: '#ff9f1a' };
const NOM_CAMP = { bleu: 'bleue', rouge: 'rouge' };

let reglage = { actif: false, reference: null, ...lireJson(STOCK, {}) }; // reference : { t, zones: { bleu: Feature|null, rouge: Feature|null } }
let features = [];
let signature = '';
let carte = null;

const campVu = () => (estJoueur() ? role.camp : etatPieces.camp);
const turf = () => window.turf;

function couverture(camp, pieces) {
  const t = turf();
  const disques = pieces
    .filter((p) => p.camp === camp && !p.detruit && rayonVision(p.vision) > 0 && (!estDrone(p) || enVol(p)))
    .map((p) => t.polygon([cercle([p.lng, p.lat], rayonVision(p.vision), 48)]));
  if (!disques.length) return null;
  return disques.length === 1 ? disques[0] : t.union(t.featureCollection(disques));
}
const sur = (f, op, g) => {
  if (!f) return null;
  if (!g) return op === 'difference' ? f : null;
  try {
    return turf()[op](turf().featureCollection([f, g]));
  } catch {
    return null;
  }
};
const forme = (f, genre, camp) => (f ? { type: 'Feature', properties: { genre, camp }, geometry: f.geometry } : null);

function calculer() {
  if (!reglage.actif || !turf()) return [];
  const pieces = listerPieces();
  const camps = estJoueur() ? [role.camp] : ['bleu', 'rouge'];
  const tenues = Object.fromEntries(camps.map((c) => [c, couverture(c, pieces)]));
  const sortie = camps.map((c) => forme(tenues[c], 'tenue', c));
  if (!estJoueur()) sortie.push(forme(sur(tenues.bleu, 'intersect', tenues.rouge), 'contestee', null));
  const camp = campVu();
  const ref = reglage.reference && reglage.reference.zones[camp];
  if (reglage.reference && tenues[camp] !== undefined) {
    sortie.push(forme(sur(tenues[camp], 'difference', ref), 'gagnee', camp));
    sortie.push(forme(ref ? sur(ref, 'difference', tenues[camp]) : null, 'perdue', camp));
  }
  return sortie.filter(Boolean);
}

export function collection() {
  return { type: 'FeatureCollection', features };
}
const rafraichir = sourceGeojson(() => carte, SOURCE_CONTROLE, collection);

const couleurDe = ['match', ['get', 'genre'], 'tenue', ['match', ['get', 'camp'], 'rouge', COULEURS.rouge, COULEURS.bleu], 'contestee', COULEURS.contestee, 'gagnee', COULEURS.gagnee, COULEURS.perdue];
export function layerSpecs() {
  return [
    {
      id: 'controle-fond',
      type: 'fill',
      source: SOURCE_CONTROLE,
      paint: { 'fill-color': couleurDe, 'fill-opacity': ['match', ['get', 'genre'], 'tenue', 0.07, 'contestee', 0.2, 0.26] }
    },
    {
      id: 'controle-trait',
      type: 'line',
      source: SOURCE_CONTROLE,
      paint: {
        'line-color': couleurDe,
        'line-width': ['match', ['get', 'genre'], 'tenue', 1, 2],
        'line-opacity': 0.9,
        'line-dasharray': ['match', ['get', 'genre'], 'perdue', ['literal', [2, 2]], ['literal', [1, 0]]]
      }
    }
  ];
}

function maj(force = false) {
  const s = reglage.actif
    ? JSON.stringify([campVu(), reglage.reference && reglage.reference.t, listerPieces().map((p) => [p.id, p.lng, p.lat, p.detruit, p.etat, p.camp, p.vision]) ])
    : '';
  if (!force && s === signature) return;
  signature = s;
  features = calculer();
  rafraichir();
}

function fixerReference() {
  const pieces = listerPieces();
  const camps = estJoueur() ? [role.camp] : ['bleu', 'rouge'];
  reglage = { ...reglage, reference: { t: Date.now(), zones: Object.fromEntries(camps.map((c) => [c, forme(couverture(c, pieces), 'tenue', c)])) } };
  ecrireJson(STOCK, reglage);
  maj(true);
  panneau();
}

const heureLocale = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function panneau() {
  const boite = document.getElementById('controle-panneau');
  if (!boite) return;
  const ref = reglage.reference;
  const case_ = h('input', { type: 'checkbox', id: 'controle-actif' });
  case_.checked = reglage.actif;
  case_.addEventListener('change', () => {
    reglage = { ...reglage, actif: case_.checked };
    ecrireJson(STOCK, reglage);
    maj(true);
    panneau();
  });
  const legende = (couleur, texte) => {
    const pastille = h('i');
    pastille.style.background = couleur;
    return h('li', {}, pastille, texte);
  };
  boite.replaceChildren(
    ...[
    h('label', { class: 'opt' }, case_, h('span', {}, 'Zones tenues, gagnées et perdues')),
    reglage.actif
      ? h(
          'div',
          {},
          h(
            'ul',
            { class: 'legende-zones' },
            legende(estJoueur() ? COULEURS[role.camp] : COULEURS.bleu, estJoueur() ? 'Zone que vos pièces observent' : 'Zone tenue par le camp'),
            estJoueur() ? null : legende(COULEURS.contestee, 'Zone contestée (les deux camps)'),
            legende(COULEURS.gagnee, 'Gagnée depuis la référence'),
            legende(COULEURS.perdue, 'Perdue depuis la référence')
          ),
          h('button', { type: 'button', onclick: fixerReference }, ref ? 'Refixer la référence maintenant' : 'Fixer la référence maintenant'),
          h(
            'p',
            { class: 'note' },
            ref
              ? `Référence fixée à ${heureLocale(ref.t)}. Gagnée et perdue se lisent pour le camp ${NOM_CAMP[campVu()] || ''}${estJoueur() ? '' : ' (celui du sélecteur de couleur)'}.`
              : "Fixez la référence pour voir ensuite ce qui est gagné ou perdu. La zone d'un camp est ce que ses pièces observent."
          )
        )
      : null
    ].filter(Boolean) // replaceChildren écrirait « null » pour un élément absent
  );
}

export function monter(map) {
  carte = map;
  panneau();
  maj(true);
  setInterval(() => maj(), PERIODE_MS);
}
