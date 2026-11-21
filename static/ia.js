// Terminal de l'assistant : l'arbitre écrit en langage courant, l'assistant propose un plan, l'arbitre l'applique (tout ou partie).
import { avecIdsReels, contexte, planifier } from './ia-actions.js';
import { listerPieces, catalogue, creerPieces, attacherPoste } from './pieces.js';
import { ajouterConsignes, etatOrdres, libelleConsigne, noterOperation } from './ordres.js';
import { ajouterDessin, listerDessins } from './dessin.js';
import { dicteeDisponible, lectureDisponible, ecouter, parler, taire } from './voix.js';
import { estJoueur, role } from './role.js';
import { envoyerOrdre } from './partie.js';
import { maintenant, enMarche, vitesse, arreter, demarrer, reglerVitesse } from './temps.js';

const DELAI_CLIENT_MS = 100000;
const ECHANGES_MEMOIRE = 4;
const PLACEHOLDER = 'Décrivez la situation…';
const EXEMPLE = "5 drones armés bleus côte à côte autour de 48,50 N 37,50 E, face à l'est. En face, 5 blindés rouges autour de 48,50 N 37,80 E. Les drones attaquent les blindés et les détruisent.";

const REGLAGES_KEY = 'wg.voix';
const state = { map: null, occupe: false, echanges: [], historique: [], rappel: -1, arreterEcoute: null, reglages: lireReglages() };
function lireReglages() {
  try { return { envoi: true, lecture: false, ...JSON.parse(localStorage.getItem(REGLAGES_KEY) || '{}') }; } catch { return { envoi: true, lecture: false }; }
}
function reglage(cle, valeur) {
  state.reglages = { ...state.reglages, [cle]: valeur };
  try { localStorage.setItem(REGLAGES_KEY, JSON.stringify(state.reglages)); } catch { /* stockage indisponible */ }
}
const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

function ajouter(noeud) {
  const fil = $('ia-fil');
  fil.append(noeud);
  fil.scrollTop = fil.scrollHeight;
  return noeud;
}
const ligne = (classe, texte) => ajouter(h('p', { class: `ia-ligne ${classe}` }, texte));

function situation() {
  const c = state.map.getCenter();
  return {
    role: estJoueur() ? { genre: 'joueur', camp: role.camp, consigne: 'Ne commande que les pièces de ce camp ; seules les actions consigne et vue sont permises.' } : { genre: 'arbitre' },
    ...contexte({ catalogue: catalogue(), pieces: listerPieces(), ordres: etatOrdres(), dessins: listerDessins(), libelleConsigne,
      vue: { lng: Math.round(c.lng * 1e4) / 1e4, lat: Math.round(c.lat * 1e4) / 1e4, zoom: Math.round(state.map.getZoom() * 10) / 10 },
      horloge: { heure_utc: new Date(maintenant()).toISOString(), vitesse: vitesse(), enMarche: enMarche() } }),
    echanges: state.echanges.slice(-ECHANGES_MEMOIRE),
  };
}

// ---------- application du plan ----------
const OPS_JOUEUR = ['consigne', 'vue'];

/** Un joueur ne peut que commander les pièces de son camp (et déplacer sa vue) : le reste du plan est refusé avec la raison. */
function restreindre(plan) {
  if (!estJoueur()) return plan;
  const propres = new Set(listerPieces().filter((p) => p.camp === role.camp).map((p) => p.id));
  return plan.map((it) => {
    if (!it.op) return it;
    if (!OPS_JOUEUR.includes(it.op.kind)) return { ...it, op: null, problemes: [...it.problemes, 'Réservé à l\'arbitre.'] };
    if (it.op.kind !== 'consigne') return it;
    const cibles = it.op.cibles.filter((c) => propres.has(c.ref));
    const refus = it.op.cibles.length - cibles.length;
    return { ...it, problemes: refus ? [...it.problemes, `${refus} pièce${refus > 1 ? 's' : ''} ne sont pas de votre camp.`] : it.problemes, op: cibles.length ? { ...it.op, cibles } : null };
  });
}

const consigneTransmise = (c) => ({ type: c.type, allure: c.allure, ...(c.type === 'aller' ? { points: c.points } : {}), ...(c.type === 'observer' ? { dureeMin: c.dureeMin } : {}), ...(c.type === 'engager' ? { cibleId: c.cibleId } : {}) });
function appliquer(items) {
  const ids = {};
  let n = 0;
  for (const { libelle, op } of items) {
    if (op.kind === 'poser') Object.assign(ids, creerPieces(op.specs));
    else if (op.kind === 'rattacher') for (const l of op.liens) attacherPoste(ids[l.ref] || l.ref, ids[l.poste] || l.poste);
    else if (op.kind === 'consigne' && estJoueur()) {
      Promise.all(op.cibles.map((c) => envoyerOrdre({ type: 'consigne', pieceId: c.ref, consigne: consigneTransmise(c.consigne) })))
        .then(() => ligne('systeme', 'Ordres transmis à l\'arbitre : leur résultat arrive dans l\'onglet Consignes.')).catch((e) => ligne('erreur', e.message));
      n += 1; continue;
    } else if (op.kind === 'consigne') ajouterConsignes(op.cibles.map((c) => avecIdsReels(c, ids)));
    else if (op.kind === 'dessin') ajouterDessin({ genre: op.genre, camp: op.camp, points: op.points, nom: op.nom });
    else if (op.kind === 'vue') state.map.flyTo({ center: [op.lng, op.lat], zoom: op.zoom, duration: 800 });
    else if (op.kind === 'temps') {
      if (op.vitesse !== null) reglerVitesse(op.vitesse);
      if (op.pause !== null) { if (op.pause) arreter(); else demarrer(); }
    }
    if (!estJoueur()) noterOperation(`Assistant : ${libelle}.`);
    n += 1;
  }
  return n;
}

function afficherPlan(items) {
  const cases = items.map((it) => (it.op ? h('input', { type: 'checkbox', checked: 'checked' }) : null));
  const lignes = items.map((it, i) => h('li', { class: it.op ? 'ok' : 'refus' },
    cases[i] ? h('label', {}, cases[i], h('span', {}, it.libelle)) : h('span', { class: 'sans-case' }, it.libelle),
    ...it.problemes.map((p) => h('small', { class: 'probleme' }, p)),
    ...(it.avertissements || []).map((p) => h('small', { class: 'avertissement' }, p))));
  const appliquables = items.filter((it) => it.op);
  const boite = ajouter(h('div', { class: 'ia-plan' }, h('ul', {}, lignes)));
  if (!appliquables.length) return;
  const bouton = h('button', { type: 'button', class: 'primaire' }, 'Appliquer');
  const ignorer = h('button', { type: 'button' }, 'Ignorer');
  const maj = () => { const n = cases.filter((c) => c && c.checked).length; bouton.textContent = n ? `Appliquer (${n})` : 'Appliquer'; bouton.disabled = !n; };
  cases.forEach((c) => c && c.addEventListener('change', maj)); maj();
  const clore = (texte) => { boite.querySelector('.ia-actions').remove(); cases.forEach((c) => c && (c.disabled = true)); if (texte) ligne('systeme', texte); };
  bouton.addEventListener('click', () => {
    const choisis = appliquables.filter((it) => cases[items.indexOf(it)].checked);
    const n = appliquer(choisis);
    clore(`${n} action${n > 1 ? 's' : ''} appliquée${n > 1 ? 's' : ''}. Elles sont notées dans le journal des opérations.`);
  });
  ignorer.addEventListener('click', () => clore('Plan ignoré.'));
  boite.append(h('div', { class: 'ia-actions' }, bouton, ignorer));
  $('ia-fil').scrollTop = $('ia-fil').scrollHeight;
}

// ---------- échange avec le serveur ----------
async function demander(prompt) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), DELAI_CLIENT_MS);
  try {
    const r = await fetch('/api/ia', { method: 'POST', body: JSON.stringify({ prompt, contexte: situation() }), signal: ctrl.signal, headers: { 'Content-Type': 'application/json', ...(role.jeton ? { 'X-Token': role.jeton, 'X-Partie': role.code } : {}) } });
    const corps = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corps.error || `Erreur ${r.status}`);
    return corps;
  } finally { clearTimeout(minuteur); }
}

async function envoyer() {
  const champ = $('ia-champ');
  const prompt = champ.value.trim();
  if (!prompt || state.occupe) return;
  state.historique = [prompt, ...state.historique.filter((p) => p !== prompt)].slice(0, 30); state.rappel = -1;
  champ.value = ''; dimensionner(); taire();
  document.querySelector('.ia-exemple')?.remove();
  ligne('moi', prompt);
  state.occupe = true; $('ia').dataset.occupe = 'oui';
  const attente = ligne('systeme attente', 'L\'assistant réfléchit');
  try {
    const rep = await demander(prompt);
    attente.remove();
    if (rep.message) { ligne('assistant', rep.message); if (state.reglages.lecture) parler(rep.message); }
    const plan = restreindre(planifier(rep.actions, { pieces: listerPieces(), catalogue: catalogue() }));
    if (plan.length) afficherPlan(plan);
    state.echanges = [...state.echanges, { arbitre: prompt, assistant: rep.message || '', actions: plan.filter((p) => p.op).map((p) => p.libelle) }].slice(-ECHANGES_MEMOIRE);
  } catch (e) {
    attente.remove();
    ligne('erreur', e.name === 'AbortError' ? 'L\'assistant n\'a pas répondu à temps.' : e.message);
  } finally { state.occupe = false; $('ia').dataset.occupe = 'non'; champ.focus(); }
}

// ---------- dictée ----------
function basculerEcoute() {
  const bouton = $('ia-micro'), champ = $('ia-champ');
  if (state.arreterEcoute) { state.arreterEcoute(); return; }
  if (state.occupe) return;
  taire();
  const base = champ.value;
  bouton.setAttribute('aria-pressed', 'true'); $('ia').dataset.ecoute = 'oui';
  champ.placeholder = 'Je vous écoute…';
  state.arreterEcoute = ecouter({
    surTexte: (texte) => { champ.value = texte ? `${base ? `${base} ` : ''}${texte}` : base; dimensionner(); },
    surErreur: (message) => ligne('erreur', message),
    surFin: (final) => {
      state.arreterEcoute = null; bouton.setAttribute('aria-pressed', 'false'); $('ia').dataset.ecoute = 'non';
      champ.placeholder = PLACEHOLDER;
      if (final && state.reglages.envoi) envoyer(); else champ.focus();
    },
  });
}

function dimensionner() { const c = $('ia-champ'); c.style.height = 'auto'; c.style.height = `${Math.min(c.scrollHeight, 140)}px`; }

export function monter(map) {
  state.map = map;
  const champ = h('textarea', { id: 'ia-champ', rows: '1', placeholder: PLACEHOLDER, 'aria-label': 'Demande à l\'assistant', spellcheck: 'false' });
  champ.addEventListener('input', dimensionner);
  champ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); envoyer(); }
    else if (e.key === 'ArrowUp' && !champ.value.includes('\n') && (champ.value === '' || state.rappel >= 0) && state.historique.length) {
      e.preventDefault(); state.rappel = Math.min(state.rappel + 1, state.historique.length - 1); champ.value = state.historique[state.rappel]; dimensionner();
    } else if (e.key === 'ArrowDown' && state.rappel >= 0) {
      e.preventDefault(); state.rappel -= 1; champ.value = state.rappel >= 0 ? state.historique[state.rappel] : ''; dimensionner();
    }
  });
  $('ia').replaceChildren(
    h('div', { id: 'ia-fil', class: 'ia-fil', 'aria-live': 'polite' },
      h('p', { class: 'ia-ligne systeme' }, 'Décrivez la situation en français : pièces, camps, positions, ordres. L\'assistant propose des actions, vous choisissez lesquelles appliquer.'),
      h('button', { type: 'button', class: 'ia-exemple', onclick: () => { champ.value = EXEMPLE; dimensionner(); champ.focus(); } }, EXEMPLE)),
    h('div', { class: 'ia-saisie' }, h('span', { class: 'ia-invite', 'aria-hidden': 'true' }, '›'), champ,
      dicteeDisponible() ? h('button', { type: 'button', id: 'ia-micro', class: 'ia-micro', 'aria-pressed': 'false', 'aria-label': 'Dicter la demande', onclick: basculerEcoute,
        'data-tip': 'Dicter la demande. Le son est traité par le fournisseur du navigateur (Apple ou Google), pas par cette application.' }, 'Micro') : null),
    h('div', { class: 'ia-aide' }, h('p', {}, 'Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne · flèche haut pour reprendre une demande'),
      dicteeDisponible() ? h('label', {}, h('input', { type: 'checkbox', checked: state.reglages.envoi ? 'checked' : null, onchange: (e) => reglage('envoi', e.target.checked) }), 'Envoyer à la fin de la phrase') : null,
      lectureDisponible() ? h('label', {}, h('input', { type: 'checkbox', checked: state.reglages.lecture ? 'checked' : null, onchange: (e) => { reglage('lecture', e.target.checked); if (!e.target.checked) taire(); } }), 'Lire les réponses à voix haute') : null));
}
