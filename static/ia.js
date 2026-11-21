// Terminal de l'assistant : l'arbitre écrit en langage courant, l'assistant propose un plan, l'arbitre l'applique (tout ou partie).
import { avecIdsReels, contexte, planifier } from './ia-actions.js';
import { listerPieces, catalogue, creerPieces } from './pieces.js';
import { ajouterConsignes, etatOrdres, libelleConsigne, noterOperation } from './ordres.js';
import { ajouterDessin, listerDessins } from './dessin.js';
import { maintenant, enMarche, vitesse, arreter, demarrer, reglerVitesse } from './temps.js';

const DELAI_CLIENT_MS = 100000;
const ECHANGES_MEMOIRE = 4;
const EXEMPLE = "5 drones armés bleus côte à côte autour de 48,50 N 37,50 E, face à l'est. En face, 5 blindés rouges autour de 48,50 N 37,80 E. Les drones attaquent les blindés et les détruisent.";

const state = { map: null, occupe: false, echanges: [], historique: [], rappel: -1 };
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
    ...contexte({ catalogue: catalogue(), pieces: listerPieces(), ordres: etatOrdres(), dessins: listerDessins(), libelleConsigne,
      vue: { lng: Math.round(c.lng * 1e4) / 1e4, lat: Math.round(c.lat * 1e4) / 1e4, zoom: Math.round(state.map.getZoom() * 10) / 10 },
      horloge: { heure_utc: new Date(maintenant()).toISOString(), vitesse: vitesse(), enMarche: enMarche() } }),
    echanges: state.echanges.slice(-ECHANGES_MEMOIRE),
  };
}

// ---------- application du plan ----------
function appliquer(items) {
  const ids = {};
  let n = 0;
  for (const { libelle, op } of items) {
    if (op.kind === 'poser') Object.assign(ids, creerPieces(op.specs));
    else if (op.kind === 'consigne') ajouterConsignes(op.cibles.map((c) => avecIdsReels(c, ids)));
    else if (op.kind === 'dessin') ajouterDessin({ genre: op.genre, camp: op.camp, points: op.points, nom: op.nom });
    else if (op.kind === 'vue') state.map.flyTo({ center: [op.lng, op.lat], zoom: op.zoom, duration: 800 });
    else if (op.kind === 'temps') {
      if (op.vitesse !== null) reglerVitesse(op.vitesse);
      if (op.pause !== null) { if (op.pause) arreter(); else demarrer(); }
    }
    noterOperation(`Assistant : ${libelle}.`);
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
    const r = await fetch('/api/ia', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, contexte: situation() }), signal: ctrl.signal });
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
  champ.value = ''; dimensionner();
  document.querySelector('.ia-exemple')?.remove();
  ligne('moi', prompt);
  state.occupe = true; $('ia').dataset.occupe = 'oui';
  const attente = ligne('systeme attente', 'L\'assistant réfléchit');
  try {
    const rep = await demander(prompt);
    attente.remove();
    if (rep.message) ligne('assistant', rep.message);
    const plan = planifier(rep.actions, { pieces: listerPieces(), catalogue: catalogue() });
    if (plan.length) afficherPlan(plan);
    state.echanges = [...state.echanges, { arbitre: prompt, assistant: rep.message || '', actions: plan.filter((p) => p.op).map((p) => p.libelle) }].slice(-ECHANGES_MEMOIRE);
  } catch (e) {
    attente.remove();
    ligne('erreur', e.name === 'AbortError' ? 'L\'assistant n\'a pas répondu à temps.' : e.message);
  } finally { state.occupe = false; $('ia').dataset.occupe = 'non'; champ.focus(); }
}

function dimensionner() { const c = $('ia-champ'); c.style.height = 'auto'; c.style.height = `${Math.min(c.scrollHeight, 140)}px`; }

export function monter(map) {
  state.map = map;
  const champ = h('textarea', { id: 'ia-champ', rows: '1', placeholder: 'Décrivez ce que vous voulez voir sur la carte', 'aria-label': 'Demande à l\'assistant', spellcheck: 'false' });
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
    h('div', { class: 'ia-saisie' }, h('span', { class: 'ia-invite', 'aria-hidden': 'true' }, '›'), champ),
    h('p', { class: 'ia-aide' }, 'Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne · flèche haut pour reprendre une demande'));
}
