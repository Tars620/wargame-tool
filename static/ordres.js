// Consignes : panneau de commandement (formulaire, liste, pointage sur la carte), ordres des joueurs et montage. Les autres modules importent d'ici.
import { formatDuree } from './geo.js';
import { ALLURES, trajetPrevu, verifier, visiblesPour, vitesse } from './moteur.js';
import { terrain } from './terrain-carte.js';
import { PARIS, heure } from './fuseaux.js';
import { maintenant } from './temps.js';
import { listerPieces, choisirPiece, positionner, restaurer } from './pieces.js';
import { estJoueur, role } from './role.js';
import { envoyerOrdre } from './partie.js';
import { aFeu, estDrone, retourPossible } from './regles.js';
import { conditions } from './meteo.js';
import { h, lireJson, $ } from './ui.js';
import { STORAGE_JOURNAL, STORAGE_ORDRES, fileDe, km, libelle, majFile, newId, nomDe, pieceCourante, sauver, state } from './ordres-etat.js';
import { dessinerJournal, noter } from './journal.js';
import { rafraichirCarte } from './ordres-carte.js';
import { majVisibilite, monterSimulation, suivreContacts } from './simulation.js';

export { SOURCE_CONSIGNES } from './ordres-etat.js';
export { collection, layerSpecs, setTheme } from './ordres-carte.js';
export { remplacerJournal } from './journal.js';

const STATUTS = { attente: 'En attente', lance: 'À démarrer', en_cours: 'En cours', terminee: 'Terminée' };
const TYPES = { aller: 'Aller à', observer: 'Observer', engager: 'Engager (feu)', rentrer: 'Rentrer se poser' };

// ---------- consignes ----------
function nouvelleConsigne(piece) {
  const f = state.forme;
  const base = { id: newId(), type: f.type, allure: f.allure, statut: 'lance' };
  if (f.type === 'aller') return { ...base, points: state.pointage ? state.pointage.points : f.points || [] };
  if (f.type === 'observer') return { ...base, dureeMin: Number(f.dureeMin) };
  if (f.type === 'rentrer') return base;
  return { ...base, cibleId: f.cibleId };
}

async function bilan(piece, consigne, pieces) {
  let meteo = null;
  if (piece.meteo_max) {
    try {
      meteo = await conditions(piece.lng, piece.lat, maintenant());
    } catch {
      meteo = null;
    }
  }
  const trajet = trajetPrevu(piece, pieces, consigne);
  if (trajet && !estDrone(piece)) {
    try {
      await terrain.assurerChemin(trajet);
    } catch {
      /* le terrain manquant est signalé par verifier */
    }
  }
  return verifier(piece, consigne, { pieces, meteo, terrain });
}

async function dessinerBilan() {
  const zone = $('o-bilan');
  const piece = pieceCourante();
  if (!zone || !piece) return;
  const pieces = listerPieces();
  const c = nouvelleConsigne(piece);
  const r = await bilan(piece, c, pieces);
  const lignes = [];
  if (r.ok && c.type !== 'observer' && Number.isFinite(r.dureeMin)) {
    const arrivee = maintenant() + r.dureeMin * 60000;
    lignes.push(`${km(r.distanceKm)} · ${formatDuree(r.dureeMin)} · fin prévue ${heure(arrivee, PARIS)} (Paris)`);
  }
  const sansDestination = c.type === 'aller' && !(c.points && c.points.length);
  if (sansDestination) lignes.push('Choisissez la destination sur la carte (plusieurs points pour un itinéraire).');
  zone.replaceChildren(
    ...lignes.map((t) => h('p', { class: 'note' }, t)),
    ...(sansDestination ? [] : r.erreurs).map((t) => h('p', { class: 'err' }, t)),
    ...r.avertissements.map((t) => h('p', { class: 'avert' }, t))
  );
  const bouton = $('o-ajouter');
  if (bouton) bouton.disabled = !r.ok;
}

async function ajouter() {
  const piece = pieceCourante();
  if (!piece) return;
  const pieces = listerPieces();
  let c = nouvelleConsigne(piece);
  const r = await bilan(piece, c, pieces);
  if (!r.ok) return;
  if (c.type === 'aller') c = { ...c, distanceKm: r.distanceKm };
  if (estJoueur()) {
    await transmettre(piece, c);
    return;
  }
  assurerDepart();
  majFile(piece.id, (file) => [...file, c]);
  if (state.pointage) arreterPointage(false);
  state.forme = { ...state.forme, points: [] };
  dessinerConsignes();
  rafraichirCarte();
}

function retirer(pieceId, id) {
  if (estJoueur()) {
    envoyerOrdre({ type: 'annuler', pieceId, consigneId: id })
      .then(() => etatOrdre("Annulation transmise à l'arbitre."))
      .catch((e) => etatOrdre(e.message, true));
    return;
  }
  majFile(pieceId, (file) => file.filter((c) => c.id !== id));
  dessinerConsignes();
  rafraichirCarte();
}

// ---------- ordres d'un joueur ----------
/** Retour affiché sous le formulaire : l'ordre est transmis, puis accepté ou refusé par l'arbitre (le motif revient avec la vue). */
function etatOrdre(texte, erreur = false) {
  const z = $('o-retour');
  if (z) z.replaceChildren(h('p', { class: erreur ? 'err' : 'note' }, texte));
}

async function transmettre(piece, c) {
  const consigne = {
    type: c.type,
    allure: c.allure,
    ...(c.type === 'aller' ? { points: c.points } : {}),
    ...(c.type === 'observer' ? { dureeMin: c.dureeMin } : {}),
    ...(c.type === 'engager' ? { cibleId: c.cibleId } : {})
  };
  try {
    await envoyerOrdre({ type: 'consigne', pieceId: piece.id, consigne });
    etatOrdre("Ordre transmis à l'arbitre.");
  } catch (e) {
    etatOrdre(e.message, true);
    return;
  }
  if (state.pointage) arreterPointage(false);
  state.forme = { ...state.forme, points: [] };
  dessinerConsignes();
}

/**
 * Arbitre : exécute l'ordre d'un joueur après l'avoir revérifié avec les VRAIES données (capacités, endurance, liaison, détection de la cible).
 * Rend { ok, message } : le joueur reçoit ce message.
 */
export async function traiterCommande(cmd) {
  const pieces = listerPieces();
  const piece = pieces.find((p) => p.id === cmd.corps.pieceId);
  if (!piece || piece.camp !== cmd.side) return { ok: false, message: 'Pièce introuvable.' };
  if (piece.detruit) return { ok: false, message: 'Cette pièce est détruite.' };
  if (cmd.corps.type === 'annuler') {
    if (!fileDe(piece.id).some((c) => c.id === cmd.corps.consigneId)) return { ok: false, message: "Cette consigne n'existe plus." };
    retirer(piece.id, cmd.corps.consigneId);
    noter(maintenant(), `${cmd.auteur} annule une consigne de ${piece.nom}.`, 'op', [cmd.side]);
    return { ok: true, message: 'Consigne annulée.' };
  }
  const c = { id: newId(), statut: 'lance', ...cmd.corps.consigne };
  if (c.type === 'engager' && !visiblesPour(cmd.side, pieces, terrain).has(c.cibleId))
    return { ok: false, message: "Cette cible n'est pas détectée par votre camp." };
  const r = await bilan(piece, c, pieces);
  if (!r.ok) return { ok: false, message: r.erreurs.join(' ') };
  ajouterConsignes([{ ref: piece.id, consigne: c.type === 'aller' ? { ...c, distanceKm: r.distanceKm } : c }]);
  noter(maintenant(), `${cmd.auteur} : ${piece.nom} reçoit « ${libelle(c, pieces)} ».`, 'op', [cmd.side]);
  return { ok: true, message: r.avertissements.length ? `Ordre accepté. ${r.avertissements.join(' ')}` : 'Ordre accepté.' };
}

/** Vue d'un joueur : consignes et journal reçus du serveur. */
export function remplacerOrdres(ordres) {
  const cle = JSON.stringify(ordres);
  if (cle === state.cleVue) return;
  state.cleVue = cle;
  state.ordres = ordres;
  listeVue = null;
  dessinerListe();
  rafraichirCarte();
}
/** Résultat d'un ordre donné par ce joueur (accepté ou refusé par l'arbitre), à afficher sous le formulaire. */
export function resultatsOrdres(commandes) {
  const dernier = commandes.find((c) => c.statut !== 'attente');
  if (dernier)
    etatOrdre(
      dernier.statut === 'traitee' ? `Accepté : ${dernier.reponse || 'ordre exécuté'}` : `Refusé : ${dernier.reponse || 'ordre non exécutable'}`,
      dernier.statut === 'refusee'
    );
}

// ---------- pointage sur la carte ----------
function demarrerPointage() {
  state.pointage = { points: [] };
  document.body.dataset.pointage = 'oui';
  state.map.getCanvas().style.cursor = 'crosshair';
  state.map.doubleClickZoom.disable();
  dessinerConsignes();
  rafraichirCarte();
}
/** Quitte le mode pointage. `garder` conserve les points posés (« Terminer »), sinon on les abandonne. */
function arreterPointage(garder = false) {
  const points = state.pointage ? state.pointage.points : [];
  state.pointage = null;
  document.body.dataset.pointage = 'non';
  state.map.getCanvas().style.cursor = '';
  state.map.doubleClickZoom.enable();
  state.forme = { ...state.forme, points: garder ? points : [] };
  dessinerConsignes();
  rafraichirCarte();
}
function pointer(lngLat) {
  state.pointage = { points: [...state.pointage.points, [lngLat.lng, lngLat.lat]] };
  state.forme = { ...state.forme, points: state.pointage.points };
  dessinerBilan();
  rafraichirCarte();
}

// ---------- opération ----------
/** Garde les positions d'avant la première consigne, pour pouvoir y revenir. */
function assurerDepart() {
  if (!state.depart) state.depart = Object.fromEntries(listerPieces().map((p) => [p.id, [p.lng, p.lat]]));
}

/** Consignes proposées par l'assistant, déjà vérifiées : { ref: id de pièce, consigne }. Elles démarrent avec l'horloge de jeu. */
export function ajouterConsignes(cibles) {
  assurerDepart();
  for (const { ref, consigne } of cibles) majFile(ref, (file) => [...file, { ...consigne, id: newId(), statut: 'lance' }]);
  dessinerConsignes();
  rafraichirCarte();
}

export const libelleConsigne = (c) => libelle(c, listerPieces());
export const etatOrdres = () => state.ordres;
export function noterOperation(texte) {
  noter(maintenant(), texte, 'op');
}

function revenirAuDepart() {
  if (state.depart) for (const [id, pos] of Object.entries(state.depart)) positionner(id, pos);
  for (const id of Object.keys(state.ordres)) {
    state.ordres = { ...state.ordres, [id]: fileDe(id).map((c) => ({ ...c, statut: 'lance', etape: 0, ecouleMin: 0 })) };
  }
  for (const p of listerPieces()) if (p.detruit) restaurer(p.id);
  state.depart = null;
  state.contactsVus = new Set();
  sauver();
  noter(maintenant(), 'Retour aux positions de départ : consignes remises à zéro, pièces détruites rétablies.', 'op');
  dessinerOperation();
  dessinerConsignes();
  rafraichirCarte();
  majVisibilite();
}

// ---------- panneau ----------
function dessinerOperation() {
  const choix = [
    ['arbitre', 'Arbitre : tout voir'],
    ['bleu', 'Camp bleu'],
    ['rouge', 'Camp rouge']
  ];
  const vue = h(
    'select',
    {
      onchange: (e) => {
        state.pointDeVue = e.target.value;
        majVisibilite();
      }
    },
    ...choix.map(([v, nom]) => h('option', { value: v, selected: v === state.pointDeVue }, nom))
  );
  $('operation').replaceChildren(
    h('label', { class: 'champ large' }, h('span', {}, 'Point de vue'), vue),
    h('button', { type: 'button', onclick: revenirAuDepart }, 'Revenir au départ'),
    h(
      'p',
      { class: 'note' },
      "Les consignes s'exécutent avec l'horloge de jeu (en haut : pause et vitesse). « Revenir au départ » replace les pièces comme avant la première consigne."
    )
  );
}

function dessinerConsignes() {
  const boite = $('consignes');
  if (!boite) return;
  const pieces = listerPieces();
  const piece = pieceCourante();
  const commandables = estJoueur() ? pieces.filter((p) => p.camp === role.camp && !p.detruit) : pieces;
  const choixPiece = h(
    'select',
    { onchange: (e) => choisirPiece(e.target.value || null) },
    h('option', { value: '' }, '— choisir une pièce —'),
    ...commandables.map((p) => h('option', { value: p.id, selected: piece && p.id === piece.id }, `${p.nom} (${p.camp})`))
  );
  if (!piece || (estJoueur() && piece.camp !== role.camp)) {
    boite.replaceChildren(
      h('label', { class: 'champ large' }, h('span', {}, 'Pièce'), choixPiece),
      h('p', { class: 'note' }, 'Posez une pièce sur la carte, puis sélectionnez-la pour lui donner des consignes.')
    );
    return;
  }

  const peutBouger = piece.mouvement.max > 0,
    peutTirer = aFeu(piece);
  const types = Object.entries(TYPES).filter(([t]) =>
    t === 'aller' ? peutBouger : t === 'engager' ? peutTirer : t === 'rentrer' ? retourPossible(piece) : true
  );
  if (!types.some(([t]) => t === state.forme.type)) state.forme = { ...state.forme, type: types[0][0] };
  const f = state.forme;
  const adverses = pieces.filter((p) => p.camp !== piece.camp);
  if (f.type === 'engager' && !adverses.some((p) => p.id === f.cibleId)) state.forme = { ...state.forme, cibleId: adverses[0] ? adverses[0].id : '' };

  const typeSel = h(
    'select',
    {
      onchange: (e) => {
        state.forme = { ...state.forme, type: e.target.value };
        if (state.pointage) arreterPointage(false);
        dessinerConsignes();
      }
    },
    ...types.map(([t, nom]) => h('option', { value: t, selected: t === state.forme.type }, nom))
  );
  const allureSel = h(
    'select',
    {
      onchange: (e) => {
        state.forme = { ...state.forme, allure: e.target.value };
        dessinerBilan();
      }
    },
    ...Object.entries(ALLURES).map(([a, nom]) =>
      h('option', { value: a, selected: a === state.forme.allure }, `${nom} · ${vitesse(piece, a).toString().replace('.', ',')} km/h`)
    )
  );
  const lignes = [
    h('label', { class: 'champ large' }, h('span', {}, 'Pièce'), choixPiece),
    h('label', { class: 'champ large' }, h('span', {}, 'Consigne'), typeSel)
  ];

  if (state.forme.type === 'aller') {
    const n = (state.pointage ? state.pointage.points : state.forme.points || []).length;
    lignes.push(
      h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel),
      state.pointage
        ? h(
            'div',
            { class: 'camps' },
            h('button', { type: 'button', onclick: () => arreterPointage(true) }, `Terminer (${n} point${n > 1 ? 's' : ''})`),
            h('button', { type: 'button', onclick: () => arreterPointage(false) }, 'Annuler')
          )
        : h(
            'button',
            { type: 'button', onclick: demarrerPointage },
            n ? `Itinéraire : ${n} point${n > 1 ? 's' : ''} (refaire)` : 'Choisir la destination sur la carte'
          )
    );
  } else if (state.forme.type === 'rentrer') {
    lignes.push(h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel));
  } else if (state.forme.type === 'observer') {
    lignes.push(
      h(
        'label',
        { class: 'champ large' },
        h('span', {}, 'Durée'),
        h('input', {
          type: 'text',
          inputmode: 'numeric',
          value: String(state.forme.dureeMin),
          oninput: (e) => {
            state.forme = { ...state.forme, dureeMin: Number(e.target.value.replace(',', '.')) || 0 };
            dessinerBilan();
          }
        })
      )
    );
  } else {
    lignes.push(
      h(
        'label',
        { class: 'champ large' },
        h('span', {}, 'Cible'),
        h(
          'select',
          {
            onchange: (e) => {
              state.forme = { ...state.forme, cibleId: e.target.value };
              dessinerBilan();
            }
          },
          ...adverses.map((p) => h('option', { value: p.id, selected: p.id === state.forme.cibleId }, `${p.nom} (${p.camp})`))
        )
      ),
      h('label', { class: 'champ large' }, h('span', {}, 'Allure'), allureSel)
    );
  }
  lignes.push(
    h('div', { id: 'o-bilan' }),
    h('button', { type: 'button', id: 'o-ajouter', class: 'primaire', onclick: ajouter }, estJoueur() ? "Transmettre l'ordre" : 'Donner la consigne'),
    h('div', { id: 'o-retour' })
  );

  boite.replaceChildren(...lignes, h('div', { id: 'o-liste' }));
  listeVue = null;
  dessinerListe();
  dessinerBilan();
}

// La suite des consignes change à chaque pas d'horloge ; le formulaire au-dessus, jamais : sinon une liste déroulante ouverte se refermerait sous la souris.
let listeVue = null;
function dessinerListe() {
  const zone = $('o-liste');
  const piece = pieceCourante();
  if (!zone || !piece) return;
  const pieces = listerPieces();
  const file = fileDe(piece.id);
  const lignes = file.map((c) => ({ id: c.id, texte: libelle(c, pieces), statut: STATUTS[c.statut] }));
  const cle = JSON.stringify([piece.id, piece.nom, lignes]);
  if (cle === listeVue) return; // rien n'a changé : on ne touche pas à la page (un clic sur « × » ne doit pas tomber dans le vide)
  listeVue = cle;
  const suite = lignes.length
    ? lignes.map((l) =>
        h(
          'div',
          { class: 'consigne' },
          h('span', {}, h('b', {}, l.texte), h('small', {}, l.statut)),
          h('button', { type: 'button', title: 'Retirer', onclick: () => retirer(piece.id, l.id) }, '×')
        )
      )
    : [h('p', { class: 'note' }, 'Aucune consigne pour cette pièce.')];
  zone.replaceChildren(h('h4', {}, `Consignes de ${piece.nom}`), ...suite);
}

/** Reconstruit le formulaire, sauf si l'arbitre est en train de s'en servir (champ actif dans le panneau). */
function dessinerConsignesSiLibre() {
  const actif = document.activeElement;
  if (actif && $('consignes') && $('consignes').contains(actif) && ['SELECT', 'INPUT'].includes(actif.tagName)) {
    dessinerListe();
    return;
  }
  dessinerConsignes();
}

// ---------- montage ----------
export function monter(map) {
  state.map = map;
  state.ordres = estJoueur()
    ? {}
    : Object.fromEntries(
        Object.entries(lireJson(STORAGE_ORDRES, {})).map(([id, file]) => [id, file.map((c) => (c.statut === 'attente' ? { ...c, statut: 'lance' } : c))])
      );
  state.journal = estJoueur() ? [] : lireJson(STORAGE_JOURNAL, []);
  map.on('click', (e) => {
    if (state.pointage) pointer(e.lngLat);
  });
  document.addEventListener('wg:piece', () => dessinerConsignes());
  document.addEventListener('wg:cascade', (e) => {
    if (estJoueur()) return;
    const pieces = listerPieces(),
      poste = pieces.find((p) => p.id === e.detail.posteId);
    const noms = e.detail.droneIds.map((id) => nomDe(pieces, id)).join(', ');
    noter(
      maintenant(),
      `LIAISON PERDUE : ${poste ? poste.nom : "l'équipe de pilotes"} est détruite, ${e.detail.droneIds.length > 1 ? 'ses drones sont détruits' : 'son drone est détruit'} : ${noms}.`,
      'alerte',
      poste ? [poste.camp] : undefined
    );
    suivreContacts(maintenant());
    majVisibilite();
    rafraichirCarte();
  });
  document.addEventListener('wg:terrain', () => {
    if (estJoueur()) return;
    suivreContacts(maintenant());
    majVisibilite();
    dessinerBilan();
  });
  document.addEventListener('wg:pieces', () => {
    const ids = new Set(listerPieces().map((p) => p.id));
    state.ordres = Object.fromEntries(Object.entries(state.ordres).filter(([id]) => ids.has(id)));
    dessinerConsignesSiLibre();
    dessinerOperation();
    rafraichirCarte();
    majVisibilite();
  });
  document.addEventListener('keydown', (e) => {
    if (!state.pointage) return;
    if (e.key === 'Escape') arreterPointage(false);
    else if (e.key === 'Enter') arreterPointage(true);
  });
  monterSimulation();
  state.redessinerListe = dessinerListe;
  dessinerOperation();
  dessinerConsignes();
  dessinerJournal();
  rafraichirCarte();
}
