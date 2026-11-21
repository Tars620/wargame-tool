import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decoder } from '../static/mvt.js';
import { FORET, EAU, ROUTE, compilerTuile, creerTerrain, voit, premiereEau, partHorsRoute, tuileDe, coinTuile } from '../static/terrain.js';
import { contacts, verifier, avancer, visiblesPour } from '../static/moteur.js';

const fixture = (nom) => decoder(new Uint8Array(readFileSync(new URL(`./fixtures/${nom}`, import.meta.url))));
const Z = 14;

// Terrain de test : une tuile synthétique autour de (X, Y), une rivière verticale, une forêt, une route. Aucune tuile voisine.
const X = 9900, Y = 5645;
const [lng0, lat0] = coinTuile(Z, X, Y), [lng1, lat1] = coinTuile(Z, X + 1, Y + 1);
const lng = (f) => lng0 + (lng1 - lng0) * f, lat = (f) => lat0 + (lat1 - lat0) * f; // f = fraction de la tuile (0..1)
const poly = (x0, y0, x1, y1) => ({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([a, b]) => [a * 4096, b * 4096]) });
const ligne = (...p) => ({ pts: p.map(([a, b]) => [a * 4096, b * 4096]) });
const decodee = {
  landuse: { extent: 4096, faces: [{ type: 3, props: { kind: 'forest' }, geom: [poly(0.1, 0.1, 0.3, 0.3)] }, { type: 3, props: { kind: 'farmland' }, geom: [poly(0.4, 0.1, 0.6, 0.3)] }] },
  water: { extent: 4096, faces: [{ type: 3, props: { kind: 'lake' }, geom: [poly(0.45, 0.4, 0.55, 0.9)] }, { type: 3, props: { kind: 'fountain' }, geom: [poly(0.8, 0.8, 0.85, 0.85)] }] },
  roads: { extent: 4096, faces: [{ type: 2, props: { kind: 'major_road' }, geom: [ligne([0, 0.65], [1, 0.65])] }, { type: 2, props: { kind: 'path', kind_detail: 'footway' }, geom: [ligne([0, 0.95], [1, 0.95])] }] },
};
async function terrainDe(d = decodee) {
  const t = creerTerrain({ charger: async () => d });
  await t.assurerTuiles([{ x: X, y: Y }]);
  return t;
}
const at = (fx, fy) => [lng(fx), lat(fy)];
const piece = (id, camp, categorie, [lg, lt], extra = {}) => ({ id, camp, categorie, lng: lg, lat: lt, mouvement: { min: 30, max: 50 }, ...extra });

test('compilerTuile : forêt, eau et route, rien pour la plaine, les fontaines et les chemins piétons', async () => {
  const t = await terrainDe();
  assert.equal(t.classe(...at(0.2, 0.2)) & FORET, FORET);
  assert.equal(t.classe(...at(0.5, 0.2)), 0, 'une ferme est de la plaine');
  assert.equal(t.classe(...at(0.5, 0.6)) & EAU, EAU);
  assert.equal(t.classe(...at(0.825, 0.825)), 0, 'une fontaine ne compte pas comme de l\'eau');
  assert.equal(t.classe(...at(0.2, 0.65)) & ROUTE, ROUTE);
  assert.equal(t.classe(...at(0.2, 0.95)) & ROUTE, 0, 'un chemin piéton n\'est pas une route');
  assert.equal(t.classe(0, 0), null, 'tuile non chargée');
});

test('voit : plaine visible, cible sous la forêt cachée (drone et fantassin), sauf tout près', async () => {
  const t = await terrainDe();
  const drone = piece('d', 'bleu', 'drone', at(0.7, 0.2), { endurance_min: 45, etat: 'vol' });
  const sol = piece('s', 'bleu', 'fantassin', at(0.7, 0.2));
  const dansForet = piece('f', 'rouge', 'fantassin', at(0.2, 0.2));
  const enPlaine = piece('p', 'rouge', 'fantassin', at(0.5, 0.2));
  assert.equal(voit(drone, enPlaine, t), true);
  assert.equal(voit(drone, dansForet, t), false, 'un drone ne voit pas un fantassin dans la forêt');
  assert.equal(voit(sol, dansForet, t), false);
  const voisin = piece('v', 'bleu', 'fantassin', [dansForet.lng + 0.0002, dansForet.lat]);
  assert.equal(voit(voisin, dansForet, t), true, 'à moins de 50 m on se voit');
});

test('voit : la forêt entre deux pièces coupe la vue au sol mais pas celle d\'un drone', async () => {
  const t = await terrainDe();
  const a = [lng(0.05), lat(0.2)], b = [lng(0.5), lat(0.2)]; // la forêt (0,1-0,3) est entre les deux
  const sol = piece('s', 'bleu', 'fantassin', a), drone = piece('d', 'bleu', 'drone', a, { endurance_min: 45, etat: 'vol' });
  const cible = piece('c', 'rouge', 'fantassin', b);
  assert.equal(voit(sol, cible, t), false);
  assert.equal(voit(drone, cible, t), true);
});

test('voit : sans terrain actif tout est visible ; tuile manquante = caché', async () => {
  const t = await terrainDe();
  const drone = piece('d', 'bleu', 'drone', at(0.7, 0.2), { endurance_min: 45, etat: 'vol' });
  const cache = piece('f', 'rouge', 'fantassin', at(0.2, 0.2));
  t.actif = false;
  assert.equal(voit(drone, cache, t), true);
  assert.equal(voit(drone, cache, null), true);
  t.actif = true;
  assert.equal(voit(drone, piece('x', 'rouge', 'fantassin', [lng(1.5), lat(0.2)]), t), false);
});

test('contacts et visiblesPour tiennent compte du terrain', async () => {
  const t = await terrainDe();
  const vision = { rayon_km: 1 };
  const pieces = [piece('d', 'bleu', 'drone', at(0.7, 0.2), { endurance_min: 45, etat: 'vol', vision }), piece('f', 'rouge', 'fantassin', at(0.2, 0.2)), piece('p', 'rouge', 'fantassin', at(0.55, 0.2))];
  assert.deepEqual(contacts(pieces).map((c) => c.cibleId).sort(), ['f', 'p']);
  assert.deepEqual(contacts(pieces, t).map((c) => c.cibleId), ['p']);
  assert.equal(visiblesPour('bleu', pieces, t).has('f'), false);
  assert.equal(visiblesPour('bleu', pieces, t).has('p'), true);
});

test('premiereEau : l\'eau arrête, un pont (route sur l\'eau) laisse passer', async () => {
  const t = await terrainDe();
  const eau = premiereEau([at(0.2, 0.5), at(0.8, 0.5)], t);
  assert.ok(eau && eau.distanceKm > 0);
  assert.equal(premiereEau([at(0.2, 0.65), at(0.8, 0.65)], t), null, 'la route traverse le lac : pont');
  assert.equal(premiereEau([at(0.2, 0.2), at(0.8, 0.2)], t), null);
});

test('verifier : un véhicule ne traverse pas l\'eau, un fantassin si ; l\'artillerie reste sur route', async () => {
  const t = await terrainDe();
  const vehicule = piece('v', 'bleu', 'vehicule', at(0.2, 0.5));
  const fantassin = piece('i', 'bleu', 'fantassin', at(0.2, 0.5));
  const consigne = { type: 'aller', points: [at(0.8, 0.5)], allure: 'normale' };
  assert.equal(verifier(fantassin, consigne, { terrain: t }).ok, true);
  const r = verifier(vehicule, consigne, { terrain: t });
  assert.equal(r.ok, false);
  assert.match(r.erreurs[0], /eau/);
  assert.equal(verifier(vehicule, consigne, { terrain: null }).ok, true, 'sans terrain : comme avant');
  const canon = piece('a', 'bleu', 'artillerie', at(0.1, 0.65), { route_seule: true, feu: { mode: 'zone', portee_km: 20 } });
  assert.equal(verifier(canon, { type: 'aller', points: [at(0.9, 0.65)], allure: 'normale' }, { terrain: t }).ok, true);
  const hors = verifier(canon, { type: 'aller', points: [at(0.7, 0.2)], allure: 'normale' }, { terrain: t });
  assert.equal(hors.ok, false);
  assert.match(hors.erreurs[0], /sur route/);
});

test('avancer : un véhicule s\'arrête avant l\'eau et le dit', async () => {
  const t = await terrainDe();
  const vehicule = piece('v', 'bleu', 'vehicule', at(0.2, 0.5), { mouvement: { min: 50, max: 50 } });
  const consigne = { type: 'aller', points: [at(0.8, 0.5)], etape: 0, allure: 'normale' };
  const r = avancer(vehicule, consigne, 60, [vehicule], '', t);
  assert.equal(r.termine, true);
  assert.equal(r.evenements[0].type, 'bloque');
  assert.ok(r.position[0] < lng(0.45), 'il reste du côté sec');
  const sans = avancer(vehicule, consigne, 1, [vehicule], '', null);
  assert.equal(sans.evenements.length, 0);
});

test('tuiles réelles : le décodage donne de l\'eau, des routes et des forêts', () => {
  const kramatorsk = compilerTuile(fixture('tuile-14-9900-5645.mvt'));
  assert.ok(kramatorsk.some((v) => v & EAU) && kramatorsk.some((v) => v & ROUTE));
  const campagne = compilerTuile(fixture('tuile-14-9898-5661.mvt'));
  assert.ok(campagne.some((v) => v & FORET), 'la campagne a des forêts');
});

test('tuileDe et coinTuile sont réciproques', () => {
  const { x, y } = tuileDe(37.55, 48.72, 14);
  const [lg, lt] = coinTuile(14, Math.floor(x), Math.floor(y));
  assert.ok(lg <= 37.55 && lt >= 48.72);
});

test('assurerChemin charge les tuiles traversées ; un échec de chargement ne bloque pas', async () => {
  const appels = [];
  const t = creerTerrain({ charger: async (z, x, y) => { appels.push([x, y]); if (x % 2) throw new Error('réseau'); return null; } });
  await t.assurerChemin([at(0.5, 0.5), [lng(0.5) + 0.06, lat(0.5)]]);
  assert.ok(appels.length >= 2);
  assert.ok(t.rapport().echecs >= 1);
  assert.equal(t.prete(), true);
  assert.equal(t.classe(...at(0.5, 0.5)), 0, 'une tuile en échec devient de la plaine');
});
