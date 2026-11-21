// Journal des opérations : lignes datées à l'heure de jeu, avec leur public (camps). Chaque ligne entre aussi dans la chaîne de la partie.
import { PARIS, date, heure } from './fuseaux.js';
import { empiler } from './partie.js';
import { role } from './role.js';
import { h, $ } from './ui.js';
import { sauver, state } from './ordres-etat.js';

const JOURNAL_MAX = 300;
const JOURNAL_AFFICHE = 60;

/**
 * Une ligne du journal. `public` dit qui peut la lire : une liste de camps, 'all', ou [] (arbitrage seul, par défaut :
 * ce qui n'a pas de public explicite ne fuit jamais). Elle est aussi enregistrée dans la chaîne de la partie.
 */
export function noter(t, texte, genre = 'info', publicVise = []) {
  state.journal = [{ t, texte, genre, visible_to: publicVise }, ...state.journal].slice(0, JOURNAL_MAX);
  sauver(); dessinerJournal();
  empiler({ texte, genre, t, visible_to: publicVise });
}

const enPartieArbitre = () => role.genre === 'arbitre';
const libellePublic = (v) => (v === 'all' ? 'tous' : Array.isArray(v) && v.length ? v.join(' et ') : 'arbitrage seul');

export function dessinerJournal() {
  const liste = $('journal-ops');
  if (!liste) return;
  if (!state.journal.length) { liste.replaceChildren(h('p', { class: 'note' }, 'Aucun événement. Les départs, arrivées, contacts et tirs apparaissent ici, à l\'heure de jeu.')); return; }
  liste.replaceChildren(...state.journal.slice(0, JOURNAL_AFFICHE).map((e) => h('div', { class: `evt evt-${e.genre}` },
    h('small', {}, `${date(e.t, PARIS)} ${heure(e.t, PARIS)} Paris${enPartieArbitre() ? ` · ${libellePublic(e.visible_to)}` : ''}`), h('span', {}, e.texte))),
  h('button', { type: 'button', class: 'danger', onclick: () => { state.journal = []; sauver(); dessinerJournal(); } }, 'Effacer le journal'));
}

/** Vue d'un joueur : le journal reçu du serveur. */
export function remplacerJournal(entrees) {
  const connus = new Set(state.journal.map((e) => `${e.t}|${e.texte}`));
  const neuves = entrees.filter((e) => !connus.has(`${e.t}|${e.texte}`));
  if (!neuves.length) return;
  state.journal = [...neuves.reverse(), ...state.journal].slice(0, JOURNAL_MAX);
  dessinerJournal();
}
