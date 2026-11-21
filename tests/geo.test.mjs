import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, destination, cercle, formatDuree, dureesDeplacement, formatKm } from '../static/geo.js';

const proche = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tolérance ${tol})`);

test('un degré de longitude à l\'équateur vaut 111,195 km', () => {
  proche(distanceKm([0, 0], [1, 0]), 111.195, 0.01);
});

test('la distance est symétrique et nulle entre deux points identiques', () => {
  const a = [-7.62, 33.59], b = [-6.84, 34.02];
  assert.equal(distanceKm(a, a), 0);
  proche(distanceKm(a, b), distanceKm(b, a), 1e-9);
});

test('Casablanca vers Rabat : 84,6 km à vol d\'oiseau (vérifié par un calcul indépendant)', () => {
  proche(distanceKm([-7.5898, 33.5731], [-6.8498, 34.0209]), 84.6, 0.2);
});

test('destination plein nord : un degré de latitude pour 111,195 km', () => {
  const [lng, lat] = destination([10, 0], 0, 111.195);
  proche(lat, 1, 0.001);
  proche(lng, 10, 1e-6);
});

test('destination puis distance : on retrouve la distance parcourue, dans toutes les directions', () => {
  for (const cap of [0, 45, 90, 135, 180, 225, 270, 315]) {
    proche(distanceKm([-7, 33], destination([-7, 33], cap, 25)), 25, 0.001);
  }
});

test('le cercle est fermé et tous ses points sont au rayon demandé', () => {
  const centre = [-7.6, 33.5];
  const anneau = cercle(centre, 15);
  assert.deepEqual(anneau[0], anneau[anneau.length - 1]);
  for (const point of anneau) proche(distanceKm(centre, point), 15, 0.01);
});

test('la destination reste dans [-180, 180] en traversant l\'antiméridien', () => {
  const [lng] = destination([179.9, 0], 90, 100);
  assert.ok(lng >= -180 && lng <= 180);
  assert.ok(lng < 0);
});

test('durées lisibles', () => {
  assert.equal(formatDuree(0.3), "moins d'1 min");
  assert.equal(formatDuree(12), '12 min');
  assert.equal(formatDuree(65), '1 h 05');
  assert.equal(formatDuree(119.6), '2 h 00');
  assert.equal(formatDuree(Infinity), '—');
});

test('12,4 km entre 50 et 70 km/h : de 11 à 15 minutes', () => {
  const { rapide, lent } = dureesDeplacement(12.4, 50, 70);
  assert.equal(Math.round(rapide), 11);
  assert.equal(Math.round(lent), 15);
});

test('une vitesse nulle donne une durée infinie, pas une erreur', () => {
  assert.equal(dureesDeplacement(5, 0, 0).lent, Infinity);
});

test('distances affichées', () => {
  assert.equal(formatKm(0.45), '450 m');
  assert.equal(formatKm(3.456), '3,46 km');
  assert.equal(formatKm(87.04), '87,0 km');
});
