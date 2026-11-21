// Partie en ligne côté interface : choix du rôle au chargement, badge, panneau de création et d'invitation, boucles de synchronisation.
import { role } from './role.js';
import { init, entrer, creer, liens, etatPublie, demarrerArbitre, demarrerJoueur, surProbleme } from './partie.js';
import { listerPieces, remplacerPieces } from './pieces.js';
import { etatOrdres, traiterCommande, remplacerOrdres, remplacerJournal, resultatsOrdres } from './ordres.js';
import { listerDessins, remplacerDessins } from './dessin.js';
import { maintenant, enMarche, vitesse, synchroniserHorloge } from './temps.js';
import { visiblesPour } from './moteur.js';
import { terrain } from './terrain-carte.js';
import { assembler, valider, CLES_STOCK } from './scenario.js';

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const NOM_CAMP = { bleu: 'Bleu', rouge: 'Rouge' };

function afficherRole() {
  document.documentElement.dataset.role = role.genre; document.body.dataset.role = role.genre;
  const b = $('badge-partie');
  if (!b) return;
  b.textContent = !role.code ? '' : `Partie ${role.code} · ${role.genre === 'joueur' ? NOM_CAMP[role.camp] : 'Arbitre'}`;
  b.dataset.camp = role.camp || '';
}

function banniere(texte) { const b = $('banniere'); if (b) { b.hidden = !texte; b.textContent = texte; } }

/** Un joueur arrivé par un lien donne son nom avant d'entrer. */
function demanderNom() {
  return new Promise((resolve) => {
    const champ = el('input', { type: 'text', placeholder: 'Votre nom', maxlength: '40', 'aria-label': 'Votre nom' });
    const erreur = el('p', { class: 'err' });
    const entrer_ = async () => { try { await entrer(champ.value || 'Joueur'); $('entree').hidden = true; resolve(); } catch (e) { erreur.textContent = e.message; } };
    champ.addEventListener('keydown', (e) => { if (e.key === 'Enter') entrer_(); });
    $('entree').replaceChildren(el('h2', {}, `Rejoindre la partie ${role.code}`), el('p', { class: 'note' }, `Vous jouez le camp ${NOM_CAMP[role.camp]}. Vous ne verrez que vos pièces et ce que votre camp détecte.`),
      champ, el('button', { type: 'button', class: 'primaire', onclick: entrer_ }, 'Entrer'), erreur);
    $('entree').hidden = false; champ.focus();
  });
}

/** À appeler au chargement, avant de monter les modules : établit le rôle de l'onglet. */
export async function preparerRole() {
  try { const r = await init(); if (r.besoinNom) await demanderNom(); } catch (e) { const z = $('err'); if (z) z.textContent = `Partie : ${e.message} (carte seule, hors partie)`; }
  afficherRole();
}

// ---------- état publié par l'arbitre ----------
function construireEtat() {
  const pieces = listerPieces();
  return { pieces, ordres: etatOrdres(), dessins: listerDessins(), horloge: { ms: Math.round(maintenant()), vitesse: vitesse(), enMarche: enMarche() },
    visibles: { bleu: [...visiblesPour('bleu', pieces, terrain)], rouge: [...visiblesPour('rouge', pieces, terrain)] } };
}

/** Arbitre dont le navigateur a perdu l'état (données effacées) : on reprend le dernier état publié sur le serveur. */
async function recupererSiVide() {
  if (listerPieces().length) return;
  const etat = await etatPublie().catch(() => null);
  if (!etat || !etat.pieces || !etat.pieces.length) return;
  const v = valider(JSON.parse(JSON.stringify(assembler({ pieces: etat.pieces, dessins: etat.dessins || [], ordres: etat.ordres || {}, journal: [] }))));
  if (!v.ok) return;
  try { for (const cle of Object.keys(CLES_STOCK)) localStorage.setItem(CLES_STOCK[cle], JSON.stringify(v.scenario[cle])); } catch { return; }
  location.reload();
}

function surVue(v) {
  if (v.vide) { banniere('En attente de l\'arbitre : la partie n\'a pas encore commencé.'); return; }
  banniere('');
  if (!v.inchange) { remplacerPieces(v.pieces); remplacerOrdres(v.ordres); remplacerDessins(v.dessins); synchroniserHorloge(v.horloge); }
  resultatsOrdres(v.commandes);
}

let synchro = false;
export async function demarrerSynchronisation() {
  if (synchro || !role.code) return;
  synchro = true;
  surProbleme((e) => banniere(`Connexion à la partie : ${e.message}`));
  if (role.genre === 'arbitre') { await recupererSiVide(); demarrerArbitre({ construireEtat, traiter: traiterCommande }); } else demarrerJoueur({ surVue, surJournal: remplacerJournal });
}

// ---------- panneau « Partie en ligne » (arbitre) ----------
const note = (t) => el('p', { class: 'note' }, t);
function ligneLien(nom, url) {
  const champ = el('input', { type: 'text', value: url, readonly: 'readonly', 'aria-label': `Lien ${nom}` });
  champ.addEventListener('focus', () => champ.select());
  return el('div', { class: 'lien-partie' }, el('span', {}, nom), champ, el('button', { type: 'button', onclick: async (e) => { try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copié'; setTimeout(() => { e.target.textContent = 'Copier'; }, 1500); } catch { champ.select(); } } }, 'Copier'));
}

export async function remplirPanneau() {
  const boite = $('partie-panneau');
  if (!boite) return;
  const creerPartie = async () => {
    try { await creer(); afficherRole(); await demarrerSynchronisation(); await rendre(); } catch (e) { boite.append(el('p', { class: 'err' }, e.message)); }
  };
  const rendre = async () => {
    if (!role.code) { boite.replaceChildren(note('Jouez seul, ou ouvrez une partie en ligne : les camps bleu et rouge se connectent par un lien et ne voient que leurs pièces.'), el('button', { type: 'button', onclick: creerPartie }, 'Créer une partie en ligne')); return; }
    if (role.genre !== 'arbitre') return;
    const l = await liens();
    boite.replaceChildren(note(`Partie ${l.code}. Un lien par joueur :`), ligneLien('Bleu', l.bleu), ligneLien('Rouge', l.rouge), l.arbitre ? ligneLien('Arbitre', l.arbitre) : null,
      note('Gardez cet onglet ouvert : la simulation tourne ici. Le lien arbitre rouvre la partie si vous fermez l\'onglet ; ne le donnez pas aux joueurs.'));
  };
  await rendre();
}
