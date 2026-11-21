import test from 'node:test';
import assert from 'node:assert/strict';
import { decalageMin, heure, etiquetteDecalage, nomZone, ecartAvecParis, parisVersMs, msVersParis, PARIS } from '../static/fuseaux.js';

const hiver = Date.UTC(2026, 10, 21, 12, 0, 0);  // 21 novembre 2026, midi UTC
const ete = Date.UTC(2026, 6, 15, 12, 0, 0);     // 15 juillet 2026

test('Paris : UTC+1 en hiver, UTC+2 en été', () => {
  assert.equal(decalageMin(hiver, PARIS), 60); assert.equal(decalageMin(ete, PARIS), 120);
  assert.equal(etiquetteDecalage(hiver, PARIS), 'UTC+1'); assert.equal(etiquetteDecalage(ete, PARIS), 'UTC+2');
});

test('l\'heure locale d\'un fuseau est décalée comme il se doit', () => {
  assert.equal(heure(hiver, PARIS), '13:00:00');
  assert.equal(heure(hiver, 'America/New_York'), '07:00:00');
  assert.equal(heure(hiver, 'Asia/Kolkata'), '17:30:00');
  assert.equal(etiquetteDecalage(hiver, 'Asia/Kolkata'), 'UTC+5:30');
});

test('Tokyo (UTC+9, sans changement d\'heure) : 8 h d\'avance sur Paris l\'hiver, 7 h l\'été', () => {
  assert.equal(ecartAvecParis(hiver, 'Asia/Tokyo'), 8); assert.equal(ecartAvecParis(ete, 'Asia/Tokyo'), 7);
});

test('écart avec Paris pour des zones à demi-heure', () => {
  assert.equal(ecartAvecParis(hiver, 'Asia/Kolkata'), 4.5); assert.equal(ecartAvecParis(hiver, 'Europe/Budapest'), 0);
});

test('saisie en heure de Paris : conversion vers UTC, hiver et été', () => {
  assert.equal(parisVersMs('2026-11-21T14:00'), Date.UTC(2026, 10, 21, 13, 0));
  assert.equal(parisVersMs('2026-07-15T14:00'), Date.UTC(2026, 6, 15, 12, 0));
});

test('aller-retour saisie ↔ heure de Paris, y compris autour du changement d\'heure d\'octobre', () => {
  for (const s of ['2026-11-21T14:05', '2026-07-15T23:59', '2026-10-25T01:30', '2026-03-29T04:00']) assert.equal(msVersParis(parisVersMs(s)), s);
});

test('saisie invalide : null', () => { assert.equal(parisVersMs(''), null); assert.equal(parisVersMs('n\'importe quoi'), null); });

test('noms de lieux', () => {
  assert.equal(nomZone('Europe/Budapest'), 'Budapest'); assert.equal(nomZone('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(nomZone('Etc/GMT+3'), 'En mer'); assert.equal(nomZone(null), 'En mer');
});
