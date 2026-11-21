import test from 'node:test';
import assert from 'node:assert/strict';

// Fausse reconnaissance vocale : on rejoue ce que le navigateur enverrait.
class Fausse {
  static derniere = null;
  constructor() { Fausse.derniere = this; this.arrete = false; }
  start() { this.demarre = true; }
  stop() { this.arrete = true; this.onend(); }
}
globalThis.window = { webkitSpeechRecognition: Fausse };
const { ecouter, dicteeDisponible } = await import('../static/voix.js');
const resultat = (...parts) => ({ resultIndex: 0, results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });

test('dictée : texte provisoire puis définitif, fin transmise avec le texte final', () => {
  assert.equal(dicteeDisponible(), true);
  const vus = []; let fin = null;
  ecouter({ surTexte: (t, f) => vus.push([t, f]), surFin: (t) => { fin = t; }, surErreur: () => assert.fail('pas d\'erreur attendue') });
  const r = Fausse.derniere;
  assert.equal(r.lang, 'fr-FR'); assert.equal(r.interimResults, true); assert.ok(r.demarre);
  r.onresult(resultat(['pose cinq', false]));
  r.onresult(resultat(['pose cinq drones', true]));
  r.onend();
  assert.deepEqual(vus, [['pose cinq', false], ['pose cinq drones', true]]);
  assert.equal(fin, 'pose cinq drones');
});

test('dictée : le silence ne produit aucune erreur affichée, le micro refusé en produit une, l\'arrêt manuel termine', () => {
  const erreurs = []; let fin = 'non';
  const arreter = ecouter({ surTexte: () => {}, surFin: (t) => { fin = t; }, surErreur: (m) => erreurs.push(m) });
  const r = Fausse.derniere;
  r.onerror({ error: 'no-speech' }); r.onerror({ error: 'not-allowed' });
  assert.equal(erreurs.length, 1); assert.match(erreurs[0], /micro/);
  arreter();
  assert.ok(r.arrete); assert.equal(fin, '');
});
