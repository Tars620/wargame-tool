import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { valider, assembler, versGeoJSON, FORMAT, VERSION } from '../static/scenario.js';

const catalogue = JSON.parse(readFileSync(new URL('../static/pieces.json', import.meta.url))).pieces;
const piece = (id = 'p1', extra = {}) => ({ id, type: 'fantassin', nom: 'Fantassin 1', camp: 'bleu', lng: 17.6, lat: 47.7,
  mouvement: { min: 4, max: 6 }, feu: { portee_km: 0.5, puissance: 2 }, vision: { rayon_km: 1.5 }, meteo_max: null, dernier_deplacement: null, ...extra });
const front = (extra = {}) => ({ id: 'd1', genre: 'front', nom: 'Ligne de front 1', camp: 'bleu', points: [[17, 47], [18, 48]], ...extra });
const bon = () => assembler({ pieces: [piece()], dessins: [front()], ordres: { p1: [{ id: 'c1', type: 'aller', allure: 'normale', statut: 'attente', points: [[17.7, 47.8]], distanceKm: 12 }] },
  journal: [{ t: 1000, texte: 'Opération lancée', genre: 'op' }] }, new Date('2026-11-21T10:00:00Z'));

test('un scénario assemblé est accepté et reste identique après validation (aller-retour)', () => {
  const r = valider(JSON.parse(JSON.stringify(bon())));
  assert.ok(r.ok, r.erreur);
  assert.deepEqual(r.scenario, bon());
});

test('format ou version inconnus : refusés avec un message clair', () => {
  assert.match(valider({ ...bon(), format: 'autre' }).erreur, /pas un scénario/);
  assert.match(valider({ ...bon(), version: 2 }).erreur, /Version/);
  assert.equal(valider(null).ok, false); assert.equal(valider('texte').ok, false); assert.equal(valider([]).ok, false);
});

test('une valeur invalide refuse tout le scénario : camp, coordonnées, vitesses, nombres non finis', () => {
  const cas = [
    (s) => { s.pieces[0].camp = 'vert'; }, (s) => { s.pieces[0].lat = 91; }, (s) => { s.pieces[0].lng = NaN; },
    (s) => { s.pieces[0].mouvement.max = -1; }, (s) => { s.pieces[0].feu.puissance = 11; }, (s) => { s.dessins[0].points = [[17, 47]]; },
    (s) => { s.dessins[0].genre = 'cercle'; }, (s) => { s.dessins[0].points[0] = [17, 'x']; },
  ];
  for (const modifier of cas) { const s = bon(); modifier(s); assert.equal(valider(s).ok, false, modifier.toString()); }
});

test('des consignes visant une pièce absente, ou un type inconnu, sont refusées', () => {
  const s = bon(); s.ordres = { fantome: s.ordres.p1 }; assert.match(valider(s).erreur, /pièce absente/);
  const t = bon(); t.ordres.p1[0].type = 'detruire'; assert.equal(valider(t).ok, false);
  const u = bon(); u.ordres.p1[0].points = []; assert.equal(valider(u).ok, false);
});

test('identifiants en double refusés', () => {
  const s = bon(); s.pieces.push(piece('p1')); assert.match(valider(s).erreur, /même identifiant/);
});

test('les champs inconnus et le contenu actif sont écartés, pas recopiés', () => {
  const s = bon();
  s.pieces[0].secret = '<script>alert(1)</script>'; s.pieces[0].__proto__ = { admin: true }; s.dessins[0].html = '<img onerror=x>';
  const r = valider(JSON.parse(JSON.stringify(s)));
  assert.ok(r.ok);
  assert.equal(r.scenario.pieces[0].secret, undefined); assert.equal(r.scenario.dessins[0].html, undefined);
  assert.equal(Object.prototype.admin, undefined);
});

test('les limites de taille protègent contre un fichier démesuré', () => {
  const s = bon(); s.pieces = Array.from({ length: 2001 }, (_, i) => piece(`p${i}`)); assert.equal(valider(s).ok, false);
  const t = bon(); t.dessins[0].points = Array.from({ length: 5001 }, () => [1, 1]); assert.equal(valider(t).ok, false);
});

test('GeoJSON : pièces en points avec leur code APP-6D, dessins en lignes et polygones', () => {
  const s = bon(); s.dessins.push({ id: 'd2', genre: 'zone', nom: 'Zone 1', camp: 'rouge', points: [[1, 1], [2, 1], [2, 2]] });
  const g = versGeoJSON(s, catalogue);
  assert.equal(g.type, 'FeatureCollection'); assert.equal(g.features.length, 3);
  const [unite, ligne, zone] = g.features;
  assert.deepEqual(unite.geometry, { type: 'Point', coordinates: [17.6, 47.7] });
  assert.equal(unite.properties.sidc, '10031000001211000000'); assert.equal(unite.properties.side, 'friend');
  assert.equal(ligne.geometry.type, 'LineString'); assert.equal(ligne.properties.measure, 'front');
  assert.equal(zone.geometry.type, 'Polygon'); assert.deepEqual(zone.geometry.coordinates[0][0], zone.geometry.coordinates[0][3]); assert.equal(zone.properties.side, 'hostile');
});

test('GeoJSON : un type inconnu du catalogue donne un code nul, pas une erreur', () => {
  const s = bon(); s.pieces[0].type = 'inconnu';
  assert.equal(versGeoJSON(s, catalogue).features[0].properties.sidc, null);
});

test('l\'assemblage porte le format, la version et la date', () => {
  const a = bon(); assert.equal(a.format, FORMAT); assert.equal(a.version, VERSION); assert.equal(a.enregistre, '2026-11-21T10:00:00.000Z');
});
