import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { couloir, COULOIR_DEFAUT_KM } from '../static/couloir.js';
import { destination } from '../static/geo.js';

const turf = createRequire(import.meta.url)('../static/vendor/turf.min.js');
const dedans = (poly, p) => turf.booleanPointInPolygon(turf.point(p), poly);

test('le couloir par défaut est de 30 km', () => assert.equal(COULOIR_DEFAUT_KM, 30));

test('une ligne nord-sud : 29 km de chaque côté est dans le couloir, 31 km est dehors', () => {
  const ligne = [[17, 47], [17, 48]];
  const poly = couloir(turf, ligne, 30);
  const milieu = [17, 47.5];
  for (const cap of [90, 270]) {
    assert.ok(dedans(poly, destination(milieu, cap, 29)), `29 km au cap ${cap}`);
    assert.ok(!dedans(poly, destination(milieu, cap, 31)), `31 km au cap ${cap}`);
  }
});

test('aux extrémités le couloir est arrondi : 29 km au-delà du bout est dedans, 31 km dehors', () => {
  const poly = couloir(turf, [[17, 47], [17, 48]], 30);
  assert.ok(dedans(poly, destination([17, 48], 0, 29))); assert.ok(!dedans(poly, destination([17, 48], 0, 31)));
  assert.ok(dedans(poly, destination([17, 47], 180, 29))); assert.ok(!dedans(poly, destination([17, 47], 180, 31)));
});

test('une ligne brisée : le coude est couvert, un point à 25 km de l\'angle intérieur aussi', () => {
  const poly = couloir(turf, [[17, 47], [17.5, 47.3], [18, 47]], 30);
  assert.ok(dedans(poly, [17.5, 47.3])); assert.ok(dedans(poly, destination([17.5, 47.3], 180, 25)));
});

test('la largeur suit le paramètre : 10 km donne un couloir plus étroit', () => {
  const ligne = [[17, 47], [17, 48]];
  const etroit = couloir(turf, ligne, 10);
  assert.ok(!dedans(etroit, destination([17, 47.5], 90, 12))); assert.ok(dedans(couloir(turf, ligne, 15), destination([17, 47.5], 90, 12)));
});

test('une ligne d\'un seul point, ou une largeur nulle : pas de couloir', () => {
  assert.equal(couloir(turf, [[17, 47]], 30), null); assert.equal(couloir(turf, [[17, 47], [17, 48]], 0), null); assert.equal(couloir(turf, null), null);
});
