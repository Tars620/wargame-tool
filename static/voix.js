// Voix : dictée (reconnaissance vocale du navigateur) et lecture des réponses. Rien n'est enregistré par l'application.
// ⚠ La reconnaissance est faite par le fournisseur du navigateur (Apple pour Safari, Google pour Chrome) : le son quitte l'ordinateur.
const LANGUE = 'fr-FR';
const Reconnaissance = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const dicteeDisponible = () => Boolean(Reconnaissance);
export const lectureDisponible = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Texte affiché pendant la dictée : ce qui était déjà écrit, puis ce qui vient d'être dit (une seule espace entre les deux). */
export function assembler(base, dit) {
  const b = String(base || '').trimEnd();
  const d = String(dit || '').trim();
  return b && d ? `${b} ${d}` : b || d;
}

const MESSAGES = {
  'not-allowed': 'Le micro est refusé : autorisez-le pour ce site dans les réglages du navigateur.',
  'service-not-allowed': 'La reconnaissance vocale est désactivée sur cet ordinateur (réglages système, dictée).',
  'audio-capture': 'Aucun micro détecté.',
  network: 'La reconnaissance vocale demande une connexion à Internet.',
  'language-not-supported': "Le français n'est pas disponible pour la reconnaissance vocale ici."
};
export const messageErreur = (code) => MESSAGES[code] || null; // « no-speech » et « aborted » ne sont pas des erreurs à montrer

/**
 * Lance une dictée. `surTexte(texte, final)` reçoit le texte reconnu (provisoire puis définitif), `surFin(texteFinal)` l'arrêt,
 * `surErreur(message)` un problème à montrer. Rend une fonction qui arrête l'écoute.
 */
export function ecouter({ surTexte, surFin, surErreur }) {
  const rec = new Reconnaissance();
  rec.lang = LANGUE;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let final = '';
  rec.onresult = (e) => {
    let provisoire = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final = assembler(final, t);
      else provisoire = assembler(provisoire, t);
    }
    surTexte(assembler(final, provisoire), provisoire === '');
  };
  rec.onerror = (e) => {
    const m = messageErreur(e.error);
    if (m) surErreur(m);
  };
  rec.onend = () => surFin(final);
  rec.start();
  return () => rec.stop();
}

let enCours = null;

/** Voix françaises installées sur cet ordinateur, triées par nom ({ name, lang }). Vide tant que le navigateur ne les a pas chargées. */
export function voixFrancaises() {
  if (!lectureDisponible()) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang && v.lang.toLowerCase().startsWith('fr'))
    .map((v) => ({ name: v.name, lang: v.lang }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
/** Appelle `fn` quand la liste des voix change (le navigateur la charge après le démarrage). */
export function surVoix(fn) {
  if (lectureDisponible()) window.speechSynthesis.addEventListener('voiceschanged', fn);
}

// Voix par défaut : Reed d'abord, puis d'autres voix d'homme naturelles (Eddy, Thomas…), en français de France avant le canadien ; sinon la première voix française.
const PREFEREES = ['Reed', 'Eddy', 'Thomas', 'Rocko', 'Grandpa', 'Jacques'];
function voixAutomatique(voix) {
  const fr = voix.filter((v) => v.lang && v.lang.toLowerCase().startsWith('fr'));
  for (const prenom of PREFEREES) {
    const trouvees = fr.filter((v) => v.name.startsWith(prenom));
    const choisie = trouvees.find((v) => v.lang.replace('_', '-').toLowerCase() === 'fr-fr') || trouvees[0];
    if (choisie) return choisie;
  }
  return fr[0] || null;
}

/** Lit un texte à voix haute (français), avec la voix demandée par son nom, sinon la première voix française. */
export function parler(texte, nomVoix = null) {
  if (!lectureDisponible() || !texte) return;
  taire();
  const u = new SpeechSynthesisUtterance(texte);
  u.lang = LANGUE;
  u.rate = 1.05;
  const voix = window.speechSynthesis.getVoices();
  const choisie = (nomVoix && voix.find((v) => v.name === nomVoix)) || voixAutomatique(voix);
  if (choisie) u.voice = choisie;
  enCours = u;
  window.speechSynthesis.speak(u);
}
export function taire() {
  if (lectureDisponible()) {
    window.speechSynthesis.cancel();
    enCours = null;
  }
}
