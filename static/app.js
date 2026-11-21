'use strict';
const TYPE_LABEL = { game_created: 'Partie créée', joined: 'Arrivée', turn_start: 'Début de tour', move: 'Coup',
  adjudication: 'Arbitrage', inject: 'Événement injecté', note: "Note d'observation", lesson: 'Leçon identifiée', game_end: 'Fin de partie' };
const ROLE_LABEL = { player: 'Joueur', adjudicator: 'Arbitre', observer: 'Observateur' };
const POLL_MS = 2000;
const STORE_KEY = 'wgl.sessions';

const S = { code: null, token: null, game: null, me: null, members: [], events: [], replayAt: null, target: null, timer: null };

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
const $ = (sel, root = document) => root.querySelector(sel);

function sessions() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } }
function saveSession(code, token) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...sessions(), [code]: token })); } catch { /* stockage indisponible */ } }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['X-Token'] = S.token;
  const r = await fetch(path, { ...opts, headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- accueil ----------
function renderHome() {
  clearInterval(S.timer);
  const params = new URLSearchParams(location.search);
  const root = $('#root');
  root.replaceChildren(el('div', { class: 'home' }, createCard(), joinCard(params.get('g') || '')));
  if (params.get('g')) loadSides();
}

function createCard() {
  const err = el('div', { class: 'err' });
  const f = (id, label, node) => [el('label', { for: id }, label), node];
  const title = el('input', { id: 'c-title', maxlength: 200 });
  const objective = el('textarea', { id: 'c-obj', placeholder: "Quelle question la partie doit-elle éclairer ?" });
  const scenario = el('textarea', { id: 'c-scn' });
  const sides = el('input', { id: 'c-sides', value: 'Bleu, Rouge' });
  const name = el('input', { id: 'c-name', maxlength: 80, placeholder: 'Vous serez arbitre' });
  const go = el('button', { onclick: async () => {
    err.textContent = '';
    try {
      const r = await post('/api/games', { title: title.value, objective: objective.value, scenario: scenario.value,
        name: name.value, sides: sides.value.split(',').map((s) => s.trim()).filter(Boolean) });
      S.token = r.token; saveSession(r.code, r.token); location.search = `?g=${r.code}`;
    } catch (e) { err.textContent = e.message; }
  } }, 'Créer la partie');
  return el('div', { class: 'card' }, el('h2', {}, 'Nouvelle partie'),
    ...f('c-title', 'Titre', title), ...f('c-obj', 'Objectif', objective), ...f('c-scn', 'Scénario', scenario),
    ...f('c-sides', 'Camps (séparés par des virgules)', sides), ...f('c-name', 'Votre nom', name), el('p', {}, go), err);
}

function joinCard(prefill) {
  const err = el('div', { class: 'err' });
  const code = el('input', { id: 'j-code', maxlength: 5, value: prefill, style: 'text-transform:uppercase', onchange: loadSides });
  const name = el('input', { id: 'j-name', maxlength: 80 });
  const kind = el('select', { id: 'j-kind', onchange: toggleKind },
    el('option', { value: 'player' }, 'Joueur'), el('option', { value: 'adjudicator' }, 'Arbitre'), el('option', { value: 'observer' }, 'Observateur'));
  const side = el('select', { id: 'j-side' });
  const key = el('input', { id: 'j-key', placeholder: "Clé fournie par l'arbitre" });
  const go = el('button', { onclick: async () => {
    err.textContent = '';
    try {
      const c = code.value.trim().toUpperCase();
      const r = await post(`/api/games/${c}/join`, { name: name.value, kind: kind.value, side: side.value, key: key.value });
      saveSession(r.code, r.token); location.search = `?g=${r.code}`;
    } catch (e) { err.textContent = e.message; }
  } }, 'Rejoindre');
  const sideBox = el('div', { id: 'j-sidebox' }, el('label', { for: 'j-side' }, 'Camp'), side);
  const keyBox = el('div', { id: 'j-keybox', style: 'display:none' }, el('label', { for: 'j-key' }, 'Clé du rôle'), key);
  return el('div', { class: 'card' }, el('h2', {}, 'Rejoindre une partie'),
    el('label', { for: 'j-code' }, 'Code de la partie'), code, el('label', { for: 'j-name' }, 'Votre nom'), name,
    el('label', { for: 'j-kind' }, 'Rôle'), kind, sideBox, keyBox, el('p', {}, go), err);
}

function toggleKind() {
  const player = $('#j-kind').value === 'player';
  $('#j-sidebox').style.display = player ? '' : 'none';
  $('#j-keybox').style.display = player ? 'none' : '';
}

async function loadSides() {
  const code = $('#j-code').value.trim().toUpperCase();
  if (code.length !== 5) return;
  try {
    const info = await api(`/api/games/${code}/info`);
    $('#j-side').replaceChildren(...info.sides.map((s) => el('option', { value: s }, s)));
  } catch { /* code encore incomplet ou inconnu */ }
}

// ---------- partie ----------
async function openGame(code) {
  S.code = code; S.token = sessions()[code] || null;
  if (!S.token) { renderHome(); return; }
  try { await refresh(true); } catch { renderHome(); return; }
  renderGame();
  S.timer = setInterval(() => refresh(false).then(updateLive).catch(() => {}), POLL_MS);
}

async function refresh(full) {
  const after = full ? 0 : (S.game ? S.game.last_seq_seen || 0 : 0);
  const st = await api(`/api/games/${S.code}/state?after=${after}`);
  S.game = { ...st.game, last_seq_seen: after };
  S.me = st.me; S.members = st.members;
  S.events = full ? st.events : S.events.concat(st.events);
  const seen = S.events.length ? S.events[S.events.length - 1].seq : 0;
  S.game.last_seq_seen = Math.max(seen, after);
  return st.events.length;
}

function renderGame() {
  const root = $('#root');
  root.replaceChildren(
    el('div', { class: 'bar', id: 'bar' }),
    el('div', { class: 'layout' }, el('div', {}, el('div', { id: 'banner' }), el('div', { class: 'timeline', id: 'tl' })),
      el('div', { class: 'panel', id: 'panel' })));
  renderBar(); renderTimeline(); renderPanel();
}

function updateLive() { renderBar(); renderTimeline(); renderPending(); }

function visibleEvents() { return S.replayAt == null ? S.events : S.events.slice(0, S.replayAt); }

function renderBar() {
  const g = S.game, bar = $('#bar');
  if (!bar) return;
  const ended = g.status === 'ended';
  const slider = el('input', { type: 'range', min: 0, max: S.events.length, value: S.replayAt ?? S.events.length,
    oninput: (e) => { const v = Number(e.target.value); S.replayAt = v >= S.events.length ? null : v; renderTimeline(); renderBanner(); } });
  const link = `${location.origin}/?g=${g.code}`;
  const staff = S.me.kind !== 'player';
  bar.replaceChildren(el('span', { class: 't' }, g.title),
    el('span', { class: 'm' }, `Code ${g.code} · ${ended ? 'terminée' : 'Tour ' + g.turn} · ${S.me.name} (${ROLE_LABEL[S.me.kind]}${S.me.side ? ', ' + S.me.side : ''})`),
    el('span', { class: 'm', title: "Empreinte du journal : à noter hors de l'outil en fin de tour" }, `empreinte ${g.head.slice(0, 10)}`),
    el('span', { class: 'replay' }, 'Rejouer', slider),
    el('button', { class: 'sec', onclick: () => navigator.clipboard && navigator.clipboard.writeText(link) }, 'Copier le lien'),
    staff || ended ? el('a', { href: `/api/games/${g.code}/export?fmt=md&token=${S.token}` }, el('button', { class: 'sec' }, 'Export .md')) : null,
    staff || ended ? el('a', { href: `/api/games/${g.code}/export?fmt=json&token=${S.token}` }, el('button', { class: 'sec' }, 'Export .json')) : null,
    staff ? el('button', { class: 'sec', onclick: verify }, 'Vérifier la chaîne') : null);
  renderBanner();
}

function renderBanner() {
  const b = $('#banner');
  if (!b) return;
  const replay = S.replayAt != null;
  b.replaceChildren(replay ? el('div', { class: 'banner' }, `Relecture : ${S.replayAt} événements sur ${S.events.length}. Lecture seule.`) : null);
  const panel = $('#panel');
  if (panel) { if (replay) panel.setAttribute('inert', ''); else panel.removeAttribute('inert'); panel.style.opacity = replay ? .4 : 1; }
}

async function verify() {
  try {
    const r = await api(`/api/games/${S.code}/verify`);
    alert(r.ok ? `Chaîne intègre : ${r.events} événements.\nEmpreinte : ${r.head}` : `CHAÎNE ROMPUE à l'événement #${r.broken_at}`);
  } catch (e) { alert(e.message); }
}

function tagFor(ev) {
  if (ev.visible_to === 'all') return null;
  const staffOnly = ev.visible_to.length === 1 && ev.visible_to[0] === 'staff';
  return el('span', { class: 'tag' }, staffOnly ? "équipe d'arbitrage" : `camp ${ev.visible_to.join(', ')}`);
}

function body(ev) {
  const p = ev.payload;
  switch (ev.type) {
    case 'move': return [el('p', {}, el('b', {}, p.action)), p.reasoning && el('p', { class: 'l' }, `Raisonnement : ${p.reasoning}`),
      p.expected_effect && el('p', { class: 'l' }, `Effet attendu : ${p.expected_effect}`)];
    case 'adjudication': return [el('p', {}, `Coup #${p.ref_seq} : ${p.outcome}`),
      p.roll && el('p', { class: 'l' }, `Jet : probabilité ${p.roll.probability}, tirage ${p.roll.value} : ${p.roll.success ? 'réussite' : 'échec'}`),
      p.rationale && el('p', { class: 'l' }, `Justification : ${p.rationale}`)];
    case 'joined': return [el('p', { class: 'l' }, `${p.name} (${ROLE_LABEL[p.kind]}${p.side ? ', ' + p.side : ''})`)];
    case 'game_created': return [el('p', { class: 'l' }, `Objectif : ${p.objective}`), p.scenario && el('p', { class: 'l' }, `Scénario : ${p.scenario}`)];
    case 'turn_start': return [el('p', {}, p.label)];
    case 'game_end': return [el('p', {}, p.summary || 'Partie terminée')];
    default: return [el('p', {}, p.text)];
  }
}

function renderTimeline() {
  const tl = $('#tl');
  if (!tl) return;
  const nodes = []; let turn = null;
  for (const ev of visibleEvents()) {
    if (ev.turn !== turn) { turn = ev.turn; nodes.push(el('div', { class: 'turn' }, `Tour ${turn}`)); }
    nodes.push(el('div', { class: 'ev' },
      el('div', { class: 'h' }, el('span', {}, `#${ev.seq}`), el('span', {}, fmtTime(ev.ts)), el('b', {}, TYPE_LABEL[ev.type] || ev.type),
        el('span', {}, `${ev.actor}${ev.side ? ' (' + ev.side + ')' : ''}`), tagFor(ev)), ...body(ev)));
  }
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
  tl.replaceChildren(...nodes);
  if (atBottom && S.replayAt == null) window.scrollTo(0, document.body.scrollHeight);
}

// ---------- panneau d'action par rôle ----------
function renderPanel() {
  const panel = $('#panel');
  if (!panel) return;
  const ended = S.game.status === 'ended';
  const parts = [];
  if (!ended) {
    if (S.me.kind === 'player') parts.push(moveForm());
    if (S.me.kind === 'adjudicator') parts.push(keysBox(), el('div', { id: 'pendingBox' }), el('div', { id: 'adjBox' }), injectForm(), turnControls());
    if (S.me.kind === 'observer') parts.push(textForm('note', "Note d'observation", 'Visible par l\'équipe d\'arbitrage et les observateurs.'));
    parts.push(textForm('lesson', 'Leçon identifiée', 'Visible par tous les participants.'));
  } else parts.push(el('div', { class: 'card' }, 'La partie est terminée. Le journal est ouvert à tous les participants.'));
  panel.replaceChildren(...parts);
  renderPending();
}

function field(label, node) { return [el('label', {}, label), node]; }

function submit(body, form, after) {
  return async () => {
    const err = $('.err', form); err.textContent = '';
    try {
      await post(`/api/games/${S.code}/events`, body());
      form.querySelectorAll('textarea,input[type=text]').forEach((n) => { n.value = ''; });
      await refresh(false); updateLive();
      if (after) after();
    } catch (e) { err.textContent = e.message; }
  };
}

function moveForm() {
  const action = el('textarea', { placeholder: 'Que faites-vous ?' });
  const reasoning = el('textarea', { placeholder: 'Pourquoi ? (conservé pour l\'analyse)' });
  const effect = el('textarea', { placeholder: 'Quel effet en attendez-vous ?' });
  const form = el('div', { class: 'card' }, el('h3', {}, `Votre coup — ${S.me.side}`), ...field('Action', action), ...field('Raisonnement', reasoning),
    ...field('Effet attendu', effect), el('p', { class: 'l' }, 'Visible seulement par votre camp et l\'équipe d\'arbitrage.'), el('p', {}, el('button', {}, 'Enregistrer le coup')), el('div', { class: 'err' }));
  $('button', form).addEventListener('click', submit(() => ({ type: 'move', action: action.value, reasoning: reasoning.value, expected_effect: effect.value }), form));
  return form;
}

function textForm(type, title, hint) {
  const text = el('textarea');
  const form = el('div', { class: 'card' }, el('h3', {}, title), text, el('p', { class: 'l' }, hint), el('p', {}, el('button', { class: 'sec' }, 'Enregistrer')), el('div', { class: 'err' }));
  $('button', form).addEventListener('click', submit(() => ({ type, text: text.value }), form));
  return form;
}

function audienceSelect(extra) {
  return el('select', {}, ...extra, el('option', { value: 'all' }, 'Tous'), ...S.game.sides.map((s) => el('option', { value: s }, `Camp ${s} seulement`)));
}

function injectForm() {
  const text = el('textarea', { placeholder: 'Nouvel événement à injecter' });
  const to = audienceSelect([]);
  const form = el('div', { class: 'card' }, el('h3', {}, 'Injecter un événement'), text, ...field('Destinataire', to), el('p', {}, el('button', { class: 'sec' }, 'Injecter')), el('div', { class: 'err' }));
  $('button', form).addEventListener('click', submit(() => ({ type: 'inject', text: text.value, reveal_to: to.value }), form));
  return form;
}

function turnControls() {
  const label = el('input', { type: 'text', placeholder: 'Libellé (ex. J+3, 06h00)' });
  const summary = el('textarea', { placeholder: 'Synthèse de fin de partie (facultatif)' });
  const form = el('div', { class: 'card' }, el('h3', {}, 'Conduite de la partie'), label,
    el('p', {}, el('button', { id: 'next' }, 'Tour suivant')), summary,
    el('p', {}, el('button', { class: 'sec', id: 'end' }, 'Terminer la partie')), el('div', { class: 'err' }));
  $('#next', form).addEventListener('click', submit(() => ({ type: 'turn_start', label: label.value }), form));
  $('#end', form).addEventListener('click', async () => {
    if (!confirm('Terminer la partie ? Le journal sera ouvert à tous les participants.')) return;
    submit(() => ({ type: 'game_end', summary: summary.value }), form, renderPanel)();
  });
  return form;
}

function keysBox() {
  const k = S.game.keys;
  return el('div', { class: 'card keys' }, el('h3', {}, 'Inviter'), `Lien : ${location.origin}/?g=${S.game.code}`, el('br'),
    'Clé arbitre ', el('code', {}, k.adjudicator), ' · clé observateur ', el('code', {}, k.observer));
}

function pendingMoves() {
  const done = new Set(S.events.filter((e) => e.type === 'adjudication').map((e) => e.payload.ref_seq));
  return S.events.filter((e) => e.type === 'move' && !done.has(e.seq));
}

function renderPending() {
  const box = $('#pendingBox');
  if (!box) return;
  const moves = pendingMoves();
  box.replaceChildren(el('div', { class: 'card' }, el('h3', {}, `Coups à arbitrer (${moves.length})`),
    el('div', { class: 'pending' }, ...moves.map((m) => el('button', { class: 'sec', onclick: () => openAdjudication(m) },
      `#${m.seq} ${m.side} : ${m.payload.action.slice(0, 70)}`)))));
}

function openAdjudication(move) {
  const outcome = el('textarea', { placeholder: 'Résultat communiqué' });
  const rationale = el('textarea', { placeholder: 'Pourquoi ce résultat ? (obligatoire, conservé pour l\'analyse)' });
  const prob = el('input', { type: 'text', placeholder: 'ex. 0.6 (laisser vide : pas de jet)' });
  const to = audienceSelect([el('option', { value: '' }, `Camp ${move.side} (par défaut)`)]);
  const form = el('div', { class: 'card' }, el('h3', {}, `Arbitrer le coup #${move.seq}`), el('p', { class: 'l' }, `${move.side} : ${move.payload.action}`),
    move.payload.reasoning && el('p', { class: 'l' }, `Raisonnement : ${move.payload.reasoning}`),
    ...field('Résultat', outcome), ...field('Justification', rationale), ...field('Jet de dé transparent (probabilité de réussite)', prob),
    ...field('Destinataire du résultat', to), el('p', {}, el('button', {}, 'Enregistrer l\'arbitrage')), el('div', { class: 'err' }));
  $('button', form).addEventListener('click', submit(() => {
    const p = prob.value.trim().replace(',', '.');
    return { type: 'adjudication', ref_seq: move.seq, outcome: outcome.value, rationale: rationale.value,
      roll_probability: p === '' ? null : Number(p), reveal_to: to.value };
  }, form, () => $('#adjBox').replaceChildren()));
  $('#adjBox').replaceChildren(form);
}

// ---------- démarrage ----------
const code = new URLSearchParams(location.search).get('g');
if (code) openGame(code.toUpperCase()); else renderHome();
