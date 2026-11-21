// Partie en ligne : création et adhésion, publication de l'état par l'arbitre, vue filtrée et ordres pour les joueurs.
// Les jetons vivent dans sessionStorage (un par onglet) : deux onglets de rôles différents ne se mélangent jamais.
import { definir, role } from './role.js';
import { ecrireJson, lireJson } from './ui.js';

const PAS_MS = 1000;
const LOT_EVENEMENTS = 50;
const CAMPS = ['bleu', 'rouge'];

const cleJeton = (code) => `wg.jeton.${code}`;
const lire = (cle) => lireJson(cle, null, sessionStorage);
const ecrire = (cle, valeur) => ecrireJson(cle, valeur, sessionStorage);

async function appel(chemin, { methode = 'GET', corps = null, jeton = role.jeton } = {}) {
  const r = await fetch(chemin, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...(jeton ? { 'X-Token': jeton } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
    cache: 'no-store'
  });
  const donnees = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(donnees.error || `Erreur ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return donnees;
}
const base = () => `/api/games/${role.code}`;

/** Lit l'adresse de la page et établit le rôle. Rend { besoinNom: true } quand un joueur doit d'abord donner son nom. */
export async function init() {
  const p = new URLSearchParams(location.search);
  const code = (p.get('partie') || '').toUpperCase();
  if (!code) return { besoinNom: false };
  const sauve = lire(cleJeton(code));
  if (sauve) {
    try {
      const { me } = await appel(`/api/games/${code}/state?after=999999999`, { jeton: sauve.jeton });
      definir(
        me.kind === 'adjudicator'
          ? { genre: 'arbitre', code, camp: null, jeton: sauve.jeton, nom: me.name }
          : { genre: 'joueur', code, camp: me.side, jeton: sauve.jeton, nom: me.name }
      );
      return { besoinNom: false };
    } catch {
      /* jeton périmé : on retente par la clé ou le nom */
    }
  }
  if (p.get('cle')) {
    await rejoindre(code, { kind: 'adjudicator', key: p.get('cle'), name: 'Arbitre' });
    return { besoinNom: false };
  }
  if (CAMPS.includes(p.get('camp'))) {
    definir({ code, camp: p.get('camp') });
    return { besoinNom: true };
  }
  throw new Error("Lien de partie incomplet : il manque le camp ou la clé de l'arbitre.");
}

async function rejoindre(code, corps) {
  const { token } = await appel(`/api/games/${code}/join`, { methode: 'POST', corps, jeton: null });
  ecrire(cleJeton(code), { jeton: token, cle: corps.key || null });
  definir(
    corps.kind === 'adjudicator'
      ? { genre: 'arbitre', code, camp: null, jeton: token, nom: corps.name }
      : { genre: 'joueur', code, camp: corps.side, jeton: token, nom: corps.name }
  );
}

/** Un joueur donne son nom et entre dans la partie du lien. */
export async function entrer(nom) {
  await rejoindre(role.code, { kind: 'player', side: role.camp, name: nom.trim().slice(0, 80) || 'Joueur' });
}

/** L'arbitre crée la partie : il en devient l'arbitre. Rend les liens à donner aux joueurs. */
export async function creer(nom = 'Arbitre') {
  const g = await appel('/api/games', {
    methode: 'POST',
    corps: { title: 'Partie sur la carte', objective: 'Wargame sur la carte', scenario: '', name: nom, sides: CAMPS },
    jeton: null
  });
  ecrire(cleJeton(g.code), { jeton: g.token, cle: g.adj_key });
  definir({ genre: 'arbitre', code: g.code, camp: null, jeton: g.token, nom });
  history.replaceState(null, '', `${location.pathname}?partie=${g.code}${location.hash}`);
  return liens();
}

/** Liens d'invitation (avec l'adresse réseau de cet ordinateur, que les autres machines peuvent joindre). */
export async function liens() {
  let origine = location.origin;
  let tunnel = { etat: 'arret' };
  let adresses = [];
  try {
    const acces = await appel('/api/acces');
    tunnel = acces.tunnel || tunnel;
    adresses = acces.adresses || [];
    origine = tunnel.etat === 'actif' ? tunnel.url : acces.reseau; // le lien Internet, s'il est actif, passe avant l'adresse du réseau local
  } catch {
    /* repli : l'adresse de la page */
  }
  const cle = (lire(cleJeton(role.code)) || {}).cle;
  return {
    tunnel,
    adresses,
    code: role.code,
    bleu: `${origine}/carte?partie=${role.code}&camp=bleu`,
    rouge: `${origine}/carte?partie=${role.code}&camp=rouge`,
    arbitre: cle ? `${origine}/carte?partie=${role.code}&cle=${cle}` : null
  };
}

// ---------- arbitre ----------
const file = [];
let publiee = null,
  enCours = false,
  suspendu = false;

/** Arrête les envois de cet onglet (avant une réinitialisation ou une nouvelle partie) : l'ancien état ne doit plus rejoindre le serveur. */
export const suspendre = () => {
  suspendu = true;
};
/** Publie un état tel quel (réinitialisation). */
export const publierEtat = (etat) => appel(`${base()}/carte`, { methode: 'POST', corps: { etat } });
/** Inscrit une ligne visible de tous au journal de la partie, tout de suite. */
export const annoncer = (texte, t) =>
  appel(`${base()}/carte/evenements`, { methode: 'POST', corps: { evenements: [{ texte, genre: 'info', visible_to: 'all', t }] } });

/** Journal : un événement de la simulation, avec ceux qui doivent le voir ('all', ['bleu'], [] = arbitrage seul). Envoyé en lots. */
export function empiler(evenement) {
  if (role.genre === 'arbitre') file.push(evenement);
}

async function tourArbitre(construireEtat, traiter) {
  if (enCours || suspendu) return;
  enCours = true;
  try {
    const etat = construireEtat();
    const cle = JSON.stringify({ ...etat, horloge: { ...etat.horloge, ms: 0 } });
    if (etat.horloge.enMarche || cle !== publiee) {
      await appel(`${base()}/carte`, { methode: 'POST', corps: { etat } });
      publiee = cle;
    }
    const { commandes } = await appel(`${base()}/carte/commandes`);
    for (const c of commandes) {
      let r;
      try {
        r = await traiter(c);
      } catch (e) {
        r = { ok: false, message: e.message };
      }
      await appel(`${base()}/carte/commandes/${c.id}`, { methode: 'POST', corps: r });
    }
    while (file.length) {
      const lot = file.splice(0, LOT_EVENEMENTS);
      try {
        await appel(`${base()}/carte/evenements`, { methode: 'POST', corps: { evenements: lot } });
      } catch (e) {
        file.unshift(...lot);
        throw e;
      }
    }
  } catch (e) {
    signaler(e);
  } finally {
    enCours = false;
  }
}

export function demarrerArbitre({ construireEtat, traiter }) {
  setInterval(() => tourArbitre(construireEtat, traiter), PAS_MS);
  tourArbitre(construireEtat, traiter);
}

/** Arbitre qui rouvre une partie dont son navigateur a perdu l'état : on retrouve le dernier état publié. */
export async function etatPublie() {
  const { etat } = await appel(`${base()}/carte/etat`);
  return etat;
}

// ---------- joueur ----------
let rev = 0,
  seq = 0;
export const envoyerOrdre = (corps) => appel(`${base()}/carte/commandes`, { methode: 'POST', corps });

export function demarrerJoueur({ surVue, surJournal }) {
  const vue = async () => {
    try {
      const v = await appel(`${base()}/carte/vue?apres=${rev}`);
      if (v.vide) {
        surVue({ vide: true, commandes: [] });
        return;
      }
      if (!v.inchange) rev = v.rev;
      surVue(v);
    } catch (e) {
      signaler(e);
    }
  };
  const journal = async () => {
    try {
      const s = await appel(`${base()}/state?after=${seq}`);
      const nouveaux = s.events.filter((e) => e.type === 'carte_event');
      if (s.events.length) seq = s.events[s.events.length - 1].seq;
      if (nouveaux.length) surJournal(nouveaux.map((e) => ({ t: e.payload.t || Date.parse(e.ts), texte: e.payload.texte, genre: e.payload.genre })));
    } catch (e) {
      signaler(e);
    }
  };
  setInterval(vue, PAS_MS);
  setInterval(journal, 2 * PAS_MS);
  vue();
  journal();
}

// ---------- erreurs de liaison avec le serveur ----------
let dernierSignal = 0;
let ecouteur = null;
export const surProbleme = (f) => {
  ecouteur = f;
};
function signaler(e) {
  const maintenant = Date.now();
  if (ecouteur && maintenant - dernierSignal > 5000) {
    dernierSignal = maintenant;
    ecouteur(e);
  }
}

/** Lien Internet temporaire (tunnel) : demande de démarrage ou d'arrêt au serveur de cet ordinateur. */
export const tunnel = (methode) => appel('/api/tunnel', { methode });
