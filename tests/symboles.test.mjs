import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { sidc } from '../static/symboles.js';

const ms = createRequire(import.meta.url)('../static/vendor/milsymbol.js');
const M = ms.default || ms;
const catalogue = JSON.parse(readFileSync(new URL('../static/pieces.json', import.meta.url))).pieces;

test('le SIDC compose version, identité, ensemble et entité sur 20 chiffres', () => {
  const infanterie = catalogue.find((m) => m.id === 'fantassin');
  assert.equal(sidc(infanterie, 'bleu'), '10031000001211000000');
  assert.equal(sidc(infanterie, 'rouge'), '10061000001211000000');
  assert.equal(sidc(infanterie, 'autre').length, 20);
});

test('chaque modèle du catalogue donne un symbole valide pour les deux camps', () => {
  assert.ok(catalogue.length >= 6);
  for (const m of catalogue) for (const camp of ['bleu', 'rouge']) {
    const s = new M.Symbol(sidc(m, camp), { size: 22 });
    assert.ok(s.isValid(false), `${m.id} (${camp}) : ${sidc(m, camp)}`);
  }
});

test('le camp bleu est un symbole ami, le rouge un symbole hostile', () => {
  for (const m of catalogue) {
    assert.equal(new M.Symbol(sidc(m, 'bleu')).getMetadata().affiliation, 'Friend');
    assert.equal(new M.Symbol(sidc(m, 'rouge')).getMetadata().affiliation, 'Hostile');
  }
});

test('les UAV sont dans l\'ensemble « air » et les autres au sol', () => {
  for (const m of catalogue) {
    const dim = new M.Symbol(sidc(m, 'bleu')).getMetadata().dimension;
    assert.equal(dim, m.categorie === 'drone' ? 'Air' : 'Ground', m.id);
  }
});
