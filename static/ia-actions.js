// Assistant : transforme la réponse du modèle en plan d'actions vérifié. Fonctions pures (testables avec node).
// Le modèle propose ; rien n'est appliqué ici. Tout est revalidé : coordonnées, modèles, pièces et capacités.
import { destination } from './geo.js';
import { ALLURES, estPoste, etatLiaison, exigePoste, lierAuto, porteeLiaison, verifier } from './moteur.js';
import { pieceDepuisModele } from './catalogue.js';
import { enduranceRestante, modeFeu, rayonVision } from './regles.js';
import { distanceKm } from './geo.js';

const ACTIONS_MAX = 20;
export const NOMBRE_MAX = 30;
const PIECES_MAX = 60;
const CAMPS = ['bleu', 'rouge'];
const GENRES = { front: 'ligne de front', limite: 'limite', zone: 'zone' };
const POINTS_MIN = { front: 2, limite: 2, zone: 3 };
const DISPOSITIONS = ['ligne', 'colonne', 'groupe'];
const VITESSES = [1, 10, 60, 300, 1800];
const ECART_TERRE_KM = 0.3;
const ECART_AIR_KM = 1;

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x.replace(',', '.')))) return Number(x.replace(',', '.'));
  return null;
};
function coord(lng, lat) {
  const a = num(lng),
    b = num(lat);
  return a !== null && b !== null && Math.abs(a) <= 180 && Math.abs(b) <= 90 ? [a, b] : null;
}
const point = (p) => (Array.isArray(p) && p.length >= 2 ? coord(p[0], p[1]) : null);
const points = (liste) => (Array.isArray(liste) ? liste.map(point) : []);
const texte = (x, max = 60) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
/** Avertissements qui ne diffèrent que par leurs chiffres : un seul, avec le nombre de pièces concernées. */
function regrouper(textes) {
  const groupes = new Map();
  for (const t of textes) {
    const cle = t.replace(/[\d.,]+/g, '#');
    const g = groupes.get(cle);
    if (g) g.n += 1;
    else groupes.set(cle, { t, n: 1 });
  }
  return [...groupes.values()].map(({ t, n }) => (n > 1 ? `${t} (${n} pièces)` : t));
}
const fr = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

/** Positions de `n` pièces autour de `centre` : ligne (côte à côte face au cap), colonne ou groupe (grille). */
export function disposer(centre, n, disposition, ecartKm, capDeg = 0) {
  const place = (dx, dy) => destination(destination(centre, capDeg + 90, dx), capDeg, dy);
  const decale = (i, total) => (i - (total - 1) / 2) * ecartKm;
  if (disposition === 'colonne') return Array.from({ length: n }, (_, i) => place(0, -decale(i, n)));
  if (disposition === 'groupe') {
    const larg = Math.ceil(Math.sqrt(n)),
      haut = Math.ceil(n / larg);
    return Array.from({ length: n }, (_, i) => place(decale(i % larg, larg), decale(Math.floor(i / larg), haut)));
  }
  return Array.from({ length: n }, (_, i) => place(decale(i, n), 0));
}

/** Ce que l'assistant sait de la situation : compact, arrondi, borné. */
export function contexte({ catalogue = [], pieces = [], ordres = {}, dessins = [], vue = null, horloge = null, libelleConsigne = () => '' }) {
  const fiche = (m) => ({
    id: m.id,
    nom: m.nom,
    categorie: m.categorie,
    vitesse_kmh: [m.mouvement.min, m.mouvement.max],
    observation_rayon_km: Math.round(rayonVision(m.vision) * 1000) / 1000,
    feu: modeFeu(m),
    ...(m.feu.cibles ? { peut_detruire: m.feu.cibles } : {}),
    ...(m.feu.zone_m2 ? { zone_detruite_m2: m.feu.zone_m2 } : {}),
    ...(m.feu.portee_km > 0 ? { feu_portee_km: m.feu.portee_km } : {}),
    ...(m.endurance_min ? { endurance_min: m.endurance_min, portee_operationnelle_km: m.portee_op_km } : {}),
    ...(m.liaison ? { exige_equipe_de_pilotes: true } : {}),
    ...(m.retour ? { rentre_se_poser: true } : {}),
    ...(m.immunise_brouillage ? { insensible_au_brouillage: true } : {}),
    ...(m.commande ? { equipe_de_pilotes: true } : {}),
    ...(m.brouillage ? { brouillage_rayon_km: m.brouillage.rayon_km } : {}),
    ...(m.route_seule ? { route_seule: true } : {})
  });
  return {
    catalogue: catalogue.map(fiche),
    pieces: pieces
      .slice(0, PIECES_MAX)
      .map((p) => ({
        id: p.id,
        nom: p.nom,
        modele: p.type,
        camp: p.camp,
        lng: r4(p.lng),
        lat: r4(p.lat),
        detruit: !!p.detruit,
        ...(p.endurance_min ? { etat: p.etat || 'sol', endurance_restante_min: Math.round(enduranceRestante(p) * 10) / 10 } : {}),
        ...(exigePoste(p) ? { equipe: p.poste || null, liaison_ok: etatLiaison(p, pieces).ok } : {}),
        consignes: (ordres[p.id] || []).filter((c) => c.statut !== 'terminee').map((c) => libelleConsigne(c))
      })),
    dessins: dessins.slice(0, 20).map((d) => ({ genre: d.genre, camp: d.camp, nom: d.nom, points: d.points.slice(0, 12).map(([x, y]) => [r4(x), r4(y)]) })),
    vue,
    horloge
  };
}

/**
 * Plan d'actions d'après la réponse du modèle. Chaque élément : { libelle, problemes[], op|null }.
 * `op` est ce qu'il faudra appliquer ; `problemes` ce qui a été refusé (et pourquoi).
 */
export function planifier(actions, { pieces = [], catalogue = [] } = {}) {
  const items = [];
  const virtuelles = [];
  const lies = new Map(); // rattachements décidés au fil du plan (poste choisi automatiquement ou demandé)
  const toutes = () => [...pieces, ...virtuelles].map((p) => (lies.has(p.id) ? { ...p, poste: lies.get(p.id) } : p));
  const relier = () => {
    for (const [id, poste] of Object.entries(lierAuto(toutes()))) lies.set(id, poste);
  };
  const vivantes = () => toutes().filter((p) => !p.detruit);
  const modele = (id) => catalogue.find((m) => m.id === id) || null;

  const parNom = (ref) => {
    const cle = texte(ref, 80).toLowerCase();
    if (!cle) return { erreur: 'pièce non précisée' };
    const exacts = toutes().filter((p) => p.id === ref);
    const trouvees = exacts.length ? exacts : toutes().filter((p) => p.nom.toLowerCase() === cle);
    if (trouvees.length === 1) return { piece: trouvees[0] };
    return { erreur: trouvees.length ? `« ${ref} » désigne plusieurs pièces` : `pièce « ${ref} » introuvable` };
  };
  const selection = (a, cle, cleListe, cleGroupe) => {
    const problemes = [];
    let liste = [];
    if (a[cle] !== undefined) {
      const r = parNom(a[cle]);
      if (r.piece) liste = [r.piece];
      else problemes.push(r.erreur);
    } else if (Array.isArray(a[cleListe]) && a[cleListe].length) {
      for (const ref of a[cleListe]) {
        const r = parNom(ref);
        if (r.piece) liste.push(r.piece);
        else problemes.push(r.erreur);
      }
    } else if (a[cleGroupe] && typeof a[cleGroupe] === 'object') {
      const { modele: m, camp } = a[cleGroupe];
      liste = vivantes().filter((p) => (!m || p.type === m) && (!camp || p.camp === camp));
      if (!liste.length) problemes.push('aucune pièce ne correspond au groupe indiqué');
    }
    return { liste: [...new Map(liste.map((p) => [p.id, p])).values()], problemes };
  };

  const poser = (a) => {
    const m = modele(a.modele),
      centre = coord(a.lng, a.lat);
    const n = Math.round(num(a.nombre) ?? 1);
    const problemes = [];
    if (!m) problemes.push(`modèle « ${texte(a.modele)} » inconnu`);
    if (!CAMPS.includes(a.camp)) problemes.push('camp à préciser (bleu ou rouge)');
    if (!centre) problemes.push('coordonnées invalides');
    if (!(n >= 1) || n > NOMBRE_MAX) problemes.push(`nombre de pièces invalide (1 à ${NOMBRE_MAX})`);
    if (toutes().length + n > PIECES_MAX) problemes.push(`trop de pièces sur la carte (${PIECES_MAX} au plus)`);
    if (problemes.length) return { libelle: 'Poser des pièces', problemes, op: null };
    const disposition = DISPOSITIONS.includes(a.disposition) ? a.disposition : 'ligne';
    const ecart = Math.min(Math.max(num(a.ecartKm) ?? (m.categorie === 'drone' ? ECART_AIR_KM : ECART_TERRE_KM), 0.01), 50);
    const cap = num(a.capDeg) ?? 0;
    const existantes = toutes().filter((p) => p.type === m.id).length;
    const specs = disposer(centre, n, disposition, ecart, cap).map(([lng, lat], i) => ({
      vid: `virt-${virtuelles.length + i}`,
      type: m.id,
      camp: a.camp,
      lng,
      lat,
      nom: `${m.nom} ${existantes + i + 1}`
    })); // numérotés par le catalogue : un nom inventé par le modèle (« PC bleu ») n'est jamais repris
    for (const s of specs) virtuelles.push({ ...pieceDepuisModele(m, { id: s.vid, nom: s.nom, camp: s.camp, lng: s.lng, lat: s.lat }), vid: s.vid });
    relier();
    const sansPoste = m.liaison ? specs.filter((sp) => !lies.has(sp.vid)).length : 0;
    const avertissements = sansPoste
      ? [
          `${sansPoste} drone${sansPoste > 1 ? 's' : ''} sans équipe de pilotes à portée (${m.portee_op_km} km) : aucune consigne possible. Posez d'abord une équipe de pilotes du même camp à portée.`
        ]
      : [];
    const lieu = `${r4(centre[1]).toString().replace('.', ',')} N, ${r4(centre[0]).toString().replace('.', ',')} E`;
    return {
      libelle: `Poser ${n > 1 ? `${n} × ` : ''}${m.nom}, ${a.camp}${n > 1 ? `, en ${disposition}, écart ${fr(ecart)} km` : ''}, près de ${lieu}`,
      problemes: [],
      avertissements,
      op: { kind: 'poser', specs }
    };
  };

  const consigne = (a) => {
    const type = a.type;
    if (!['aller', 'observer', 'engager', 'rentrer'].includes(type)) return { libelle: 'Consigne', problemes: [`type « ${texte(a.type)} » inconnu`], op: null };
    const { liste: acteurs, problemes } = selection(a, 'piece', 'pieces', 'groupe');
    if (!acteurs.length) return { libelle: 'Consigne', problemes: problemes.length ? problemes : ['aucune pièce désignée'], op: null };
    const allure = Object.hasOwn(ALLURES, a.allure) ? a.allure : 'normale';
    let adverses = [];
    if (type === 'engager') {
      const sel = a.cible !== undefined ? selection({ piece: a.cible }, 'piece') : selection(a, 'cible_', 'cibles', 'cibleGroupe');
      problemes.push(...sel.problemes);
      adverses = sel.liste.filter((p) => !p.detruit);
      if (!adverses.length) return { libelle: 'Engager', problemes: [...problemes, 'aucune cible valide'], op: null };
    }
    const pts = points(a.points);
    if (type === 'aller' && (!pts.length || pts.includes(null)))
      return { libelle: 'Aller à', problemes: [...problemes, 'destination manquante ou invalide'], op: null };
    const dureeMin = num(a.dureeMin);
    const cibles = [];
    acteurs.forEach((p, i) => {
      if (p.detruit) {
        problemes.push(`${p.nom} est détruit`);
        return;
      }
      const c =
        type === 'aller'
          ? { type, allure, points: pts }
          : type === 'observer'
            ? { type, allure, dureeMin }
            : type === 'rentrer'
              ? { type, allure }
              : { type, allure, cibleId: adverses[i % adverses.length].id };
      const r = verifier(p, c, { pieces: vivantes() });
      if (r.ok) cibles.push({ ref: p.id, consigne: type === 'aller' ? { ...c, distanceKm: r.distanceKm } : c, avertissements: r.avertissements });
      else problemes.push(`${p.nom} : ${r.erreurs.join(' ')}`);
    });
    const verbe =
      type === 'aller'
        ? `aller à ${pts.length > 1 ? `${pts.length} points` : 'un point'}`
        : type === 'observer'
          ? `observer ${fr(dureeMin || 0)} min`
          : type === 'rentrer'
            ? 'rentrer se poser'
            : `engager ${adverses.length > 1 ? `${adverses.length} cibles` : adverses[0].nom}`;
    const nom = acteurs.length > 1 ? `${acteurs.length} pièces` : acteurs[0].nom;
    return {
      libelle: `${nom} : ${verbe}`,
      problemes,
      avertissements: regrouper(cibles.flatMap((c) => c.avertissements)),
      op: cibles.length ? { kind: 'consigne', cibles } : null
    };
  };

  const rattacher = (a) => {
    const { liste: drones, problemes } = selection(a, 'piece', 'pieces', 'groupe');
    const r = a.poste !== undefined ? parNom(a.poste) : { erreur: 'poste non précisé' };
    if (!r.piece) return { libelle: 'Rattacher à une équipe', problemes: [...problemes, r.erreur], op: null };
    const poste = r.piece;
    if (!estPoste(poste)) return { libelle: 'Rattacher à une équipe', problemes: [`${poste.nom} n'est pas une équipe de pilotes`], op: null };
    const liens = [];
    for (const d of drones) {
      if (!exigePoste(d)) problemes.push(`${d.nom} n'a pas besoin d'équipe de pilotes`);
      else if (d.camp !== poste.camp) problemes.push(`${d.nom} : ${poste.nom} est d'un autre camp`);
      else if (poste.detruit) problemes.push(`${poste.nom} est détruite`);
      else if (distanceKm([d.lng, d.lat], [poste.lng, poste.lat]) > porteeLiaison(d, poste))
        problemes.push(`${d.nom} est à plus de ${porteeLiaison(d, poste)} km de ${poste.nom}`);
      else liens.push({ ref: d.id, poste: poste.id });
    }
    liens.forEach((l) => lies.set(l.ref, l.poste));
    return {
      libelle: `Rattacher ${liens.length > 1 ? `${liens.length} drones` : drones[0] ? drones[0].nom : 'des drones'} à ${poste.nom}`,
      problemes,
      op: liens.length ? { kind: 'rattacher', liens } : null
    };
  };

  const dessin = (a) => {
    const pts = points(a.points);
    const problemes = [];
    if (!Object.hasOwn(GENRES, a.genre)) problemes.push(`genre « ${texte(a.genre)} » inconnu`);
    else if (pts.length < POINTS_MIN[a.genre] || pts.includes(null)) problemes.push(`${POINTS_MIN[a.genre]} points valides au moins`);
    const camp = [...CAMPS, 'neutre'].includes(a.camp) ? a.camp : 'neutre';
    if (problemes.length) return { libelle: 'Dessin', problemes, op: null };
    return {
      libelle: `Tracer une ${GENRES[a.genre]} ${camp} (${pts.length} points)`,
      problemes: [],
      op: { kind: 'dessin', genre: a.genre, camp, points: pts, nom: texte(a.nom) }
    };
  };

  const vue = (a) => {
    const c = coord(a.lng, a.lat),
      zoom = num(a.zoom);
    if (!c) return { libelle: 'Déplacer la vue', problemes: ['coordonnées invalides'], op: null };
    const z = Math.min(Math.max(zoom ?? 8, 1), 20);
    return { libelle: `Centrer la carte sur ${r4(c[1])} N, ${r4(c[0])} E (zoom ${fr(z)})`, problemes: [], op: { kind: 'vue', lng: c[0], lat: c[1], zoom: z } };
  };

  const temps = (a) => {
    const v = num(a.vitesse);
    if (v !== null && !VITESSES.includes(v)) return { libelle: 'Horloge', problemes: [`vitesse ${v} non disponible (${VITESSES.join(', ')})`], op: null };
    if (v === null && typeof a.pause !== 'boolean') return { libelle: 'Horloge', problemes: ['rien à régler'], op: null };
    const dit = [v !== null ? `vitesse ×${v}` : '', typeof a.pause === 'boolean' ? (a.pause ? 'pause' : 'reprise') : ''].filter(Boolean).join(', ');
    return { libelle: `Horloge de jeu : ${dit}`, problemes: [], op: { kind: 'temps', vitesse: v, pause: typeof a.pause === 'boolean' ? a.pause : null } };
  };

  const FABRIQUES = { poser, rattacher, consigne, dessin, vue, temps };
  const liste = Array.isArray(actions) ? actions : [];
  for (const a of liste.slice(0, ACTIONS_MAX)) {
    const f = a && typeof a === 'object' ? FABRIQUES[a.action] : null;
    items.push(f ? f(a) : { libelle: 'Action inconnue', problemes: [`action « ${texte(a && a.action)} » non prise en charge`], op: null });
  }
  if (liste.length > ACTIONS_MAX)
    items.push({
      libelle: 'Actions en trop',
      problemes: [`${liste.length - ACTIONS_MAX} action(s) ignorée(s) : ${ACTIONS_MAX} au plus par demande`],
      op: null
    });
  return items;
}

/** Remplace les identifiants provisoires (pièces posées dans le même plan) par les identifiants réels. */
export function avecIdsReels(cible, ids) {
  const reel = (id) => ids[id] || id;
  const { consigne } = cible;
  return { ref: reel(cible.ref), consigne: consigne.cibleId ? { ...consigne, cibleId: reel(consigne.cibleId) } : consigne };
}
