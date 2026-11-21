// Construction des pièces depuis le catalogue, et migration des pièces enregistrées avec l'ancien catalogue. Fonctions pures.
import { rayonVision } from './regles.js';

const copie = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const OPTIONNELS = ['endurance_min', 'portee_op_km', 'retour', 'immunise_brouillage', 'liaison', 'commande', 'brouillage', 'route_seule', 'meteo_max'];

/** Une pièce neuve d'après son modèle : tout ce qui décrit la pièce est copié, rien n'est partagé avec le catalogue. */
export function pieceDepuisModele(modele, { id, nom, camp, lng, lat }) {
  const p = { id, type: modele.id, icone: modele.icone, categorie: modele.categorie, nom, camp, lng, lat,
    mouvement: copie(modele.mouvement), feu: copie(modele.feu),
    vision: { ...copie(modele.vision), rayon_km: rayonVision(modele.vision) }, dernier_deplacement: null };
  for (const cle of OPTIONNELS) if (modele[cle] !== undefined) p[cle] = copie(modele[cle]);
  if (p.meteo_max === undefined) p.meteo_max = null;
  if (p.endurance_min > 0) { p.etat = 'sol'; p.endurance_restante_min = p.endurance_min; }
  return p;
}

/** Ancien type de pièce -> nouveau modèle. Les autres anciens types (blindé) n'ont pas d'équivalent. */
const CORRESPONDANCE = { 'uav-reco': 'drone-isr', 'uav-arme': 'drone-owa', 'poste-commandement': 'equipe-pilotes', 'guerre-electronique': 'brouilleur' };
const ANCIENS_NOMS = { 'uav-reco': 'UAV de reconnaissance', 'uav-arme': 'UAV armé', 'poste-commandement': 'Poste de commandement', 'guerre-electronique': 'Guerre électronique' };

/**
 * Remet à jour des pièces enregistrées : celles de l'ancien catalogue sont reconstruites sur leur nouveau modèle (identité, camp,
 * position, rattachement et état détruit conservés) ; celles sans équivalent sont retirées et rendues dans `retirees`.
 */
export function migrerPieces(pieces, catalogue) {
  const sorties = [];
  const retirees = [];
  for (const p of pieces) {
    const ancien = !p.categorie;
    if (!ancien) { sorties.push(p.type === 'equipe-pilotes' && /^PC( |$)/.test(p.nom) ? { ...p, nom: p.nom.replace(/^PC/, 'Équipe de pilotes') } : p); continue; }
    const type = CORRESPONDANCE[p.type] || p.type;
    const modele = catalogue.find((m) => m.id === type);
    if (!modele) { retirees.push(p.nom); continue; }
    const prefixe = ANCIENS_NOMS[p.type];
    const nom = prefixe && p.nom.startsWith(prefixe) ? `${modele.nom}${p.nom.slice(prefixe.length)}` : (p.type === 'poste-commandement' && /^PC( |$)/.test(p.nom) ? p.nom.replace(/^PC/, modele.nom) : p.nom);
    const neuve = pieceDepuisModele(modele, { id: p.id, nom, camp: p.camp, lng: p.lng, lat: p.lat });
    if (p.poste) neuve.poste = p.poste;
    if (p.detruit) neuve.detruit = true;
    if (p.dernier_deplacement) neuve.dernier_deplacement = p.dernier_deplacement;
    sorties.push(neuve);
  }
  return { pieces: sorties, retirees };
}
