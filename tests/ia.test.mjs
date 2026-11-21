import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm } from '../static/geo.js';
import { disposer, planifier, contexte, avecIdsReels, NOMBRE_MAX } from '../static/ia-actions.js';
import { assembler, messageErreur } from '../static/voix.js';
import { contacts, avancer, verifier } from '../static/moteur.js';

const catalogue = [
  { id: 'uav-arme', nom: 'UAV armé', mouvement: { min: 60, max: 150 }, feu: { portee_km: 10, puissance: 4 }, vision: { rayon_km: 8 } },
  { id: 'uav-reco', nom: 'UAV de reconnaissance', mouvement: { min: 60, max: 120 }, feu: { portee_km: 0, puissance: 0 }, vision: { rayon_km: 15 } },
  { id: 'blinde', nom: 'Véhicule blindé', mouvement: { min: 50, max: 70 }, feu: { portee_km: 3, puissance: 6 }, vision: { rayon_km: 3 } },
];
const proche = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const scenario = [
  { action: 'poser', modele: 'uav-arme', camp: 'bleu', lng: 37.5, lat: 48.5, nombre: 5, disposition: 'ligne', capDeg: 90 },
  { action: 'poser', modele: 'blinde', camp: 'rouge', lng: 37.8, lat: 48.5, nombre: 5, disposition: 'ligne', capDeg: 270 },
  { action: 'consigne', groupe: { modele: 'uav-arme', camp: 'bleu' }, type: 'engager', cibles: [], cibleGroupe: { modele: 'blinde', camp: 'rouge' }, detruit: true },
];

test('ligne : 5 pièces côte à côte, perpendiculaires au cap, écart demandé, centrées', () => {
  const pos = disposer([37.5, 48.5], 5, 'ligne', 1, 90); // face à l'est : la ligne court nord-sud
  assert.equal(pos.length, 5);
  for (let i = 1; i < 5; i++) { proche(distanceKm(pos[i - 1], pos[i]), 1, 0.01); proche(pos[i][0], 37.5, 1e-3); }
  proche(pos[2][1], 48.5, 1e-9);
});

test('colonne : pièces l\'une derrière l\'autre le long du cap', () => {
  const pos = disposer([0, 0], 3, 'colonne', 2, 0);
  proche(distanceKm(pos[0], pos[2]), 4, 0.02); proche(pos[0][0], pos[2][0], 1e-6);
});

test('groupe : grille compacte, aucune pièce superposée', () => {
  const pos = disposer([10, 10], 7, 'groupe', 0.5, 0);
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) assert.ok(distanceKm(pos[i], pos[j]) > 0.4);
});

test('la demande type : 5 drones bleus, 5 blindés rouges, drones qui engagent et détruisent', () => {
  const plan = planifier(scenario, { pieces: [], catalogue });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((p) => p.problemes), [[], [], []]);
  assert.equal(plan[0].op.specs.length, 5); assert.equal(plan[1].op.specs.length, 5);
  assert.equal(plan[2].op.cibles.length, 5);
  const bleus = new Set(plan[0].op.specs.map((s) => s.vid));
  const rouges = new Set(plan[1].op.specs.map((s) => s.vid));
  for (const c of plan[2].op.cibles) { assert.ok(bleus.has(c.ref)); assert.ok(rouges.has(c.consigne.cibleId)); assert.equal(c.consigne.detruit, true); }
  assert.equal(new Set(plan[2].op.cibles.map((c) => c.consigne.cibleId)).size, 5, 'une cible par drone');
});

test('noms numérotés à la suite des pièces existantes', () => {
  const existantes = [{ id: 'x', type: 'blinde', nom: 'Véhicule blindé 1', camp: 'rouge', lng: 0, lat: 0, mouvement: catalogue[2].mouvement, feu: catalogue[2].feu, vision: catalogue[2].vision }];
  const plan = planifier([{ action: 'poser', modele: 'blinde', camp: 'rouge', lng: 1, lat: 1, nombre: 2 }], { pieces: existantes, catalogue });
  assert.deepEqual(plan[0].op.specs.map((s) => s.nom), ['Véhicule blindé 2', 'Véhicule blindé 3']);
});

test('une pièce sans arme ne peut pas engager : refus expliqué, les autres passent', () => {
  const plan = planifier([
    { action: 'poser', modele: 'uav-reco', camp: 'bleu', lng: 1, lat: 1, nombre: 1 },
    { action: 'poser', modele: 'uav-arme', camp: 'bleu', lng: 1.1, lat: 1, nombre: 1 },
    { action: 'poser', modele: 'blinde', camp: 'rouge', lng: 1.2, lat: 1, nombre: 1 },
    { action: 'consigne', groupe: { camp: 'bleu' }, type: 'engager', cible: 'Véhicule blindé 1' },
  ], { pieces: [], catalogue });
  assert.equal(plan[3].op.cibles.length, 1);
  assert.match(plan[3].problemes.join(' '), /aucun feu/);
});

test('refuse sans rien appliquer : modèle inconnu, camp absent, coordonnées folles, trop de pièces', () => {
  const plan = planifier([
    { action: 'poser', modele: 'char-fantome', camp: 'bleu', lng: 1, lat: 1 },
    { action: 'poser', modele: 'blinde', lng: 1, lat: 1 },
    { action: 'poser', modele: 'blinde', camp: 'bleu', lng: 500, lat: 1 },
    { action: 'poser', modele: 'blinde', camp: 'bleu', lng: 1, lat: 1, nombre: NOMBRE_MAX + 1 },
    { action: 'detruire_tout' },
    null,
  ], { pieces: [], catalogue });
  assert.ok(plan.every((p) => p.op === null && p.problemes.length === 1), JSON.stringify(plan));
});

test('une pièce désignée par son nom ambigu ou inconnue est refusée', () => {
  const p = (id, nom) => ({ id, type: 'blinde', nom, camp: 'bleu', lng: 0, lat: 0, mouvement: catalogue[2].mouvement, feu: catalogue[2].feu, vision: catalogue[2].vision });
  const pieces = [p('a', 'Char'), p('b', 'Char')];
  const plan = planifier([{ action: 'consigne', piece: 'Char', type: 'observer', dureeMin: 5 }, { action: 'consigne', piece: 'Fantôme', type: 'observer', dureeMin: 5 }], { pieces, catalogue });
  assert.match(plan[0].problemes[0], /plusieurs/); assert.match(plan[1].problemes[0], /introuvable/);
});

test('consigne aller : points obligatoires et valides, distance calculée', () => {
  const pieces = [{ id: 'd', type: 'uav-arme', nom: 'Drone', camp: 'bleu', lng: 0, lat: 0, mouvement: catalogue[0].mouvement, feu: catalogue[0].feu, vision: catalogue[0].vision }];
  const ok = planifier([{ action: 'consigne', piece: 'd', type: 'aller', points: [[0, 1]], allure: 'maximale' }], { pieces, catalogue });
  proche(ok[0].op.cibles[0].consigne.distanceKm, 111.2, 0.5);
  const ko = planifier([{ action: 'consigne', piece: 'd', type: 'aller', points: [[0, 'x']] }, { action: 'consigne', piece: 'd', type: 'aller' }], { pieces, catalogue });
  assert.ok(ko.every((p) => p.op === null));
});

test('dessin, vue, temps : validés champ par champ', () => {
  const plan = planifier([
    { action: 'dessin', genre: 'front', camp: 'bleu', points: [[1, 1], [2, 2]] },
    { action: 'dessin', genre: 'zone', camp: 'rouge', points: [[1, 1], [2, 2]] },
    { action: 'vue', lng: 37.6, lat: 48.5, zoom: 99 },
    { action: 'temps', vitesse: 60, pause: false },
    { action: 'temps', vitesse: 7 },
  ], { pieces: [], catalogue });
  assert.deepEqual(plan.map((p) => p.op !== null), [true, false, true, true, false]);
  assert.equal(plan[2].op.zoom, 20);
});

test('pas plus de 20 actions par demande', () => {
  const plan = planifier(Array.from({ length: 25 }, () => ({ action: 'vue', lng: 1, lat: 1 })), { pieces: [], catalogue });
  assert.equal(plan.length, 21); assert.equal(plan[20].op, null);
});

test('pièce détruite : plus de contact, plus de cible, plus de tir sur elle', () => {
  const v = { vision: { rayon_km: 20 }, mouvement: { min: 1, max: 1 }, feu: { portee_km: 5, puissance: 1 } };
  const a = { id: 'a', camp: 'bleu', lng: 0, lat: 0, ...v }, b = { id: 'b', camp: 'rouge', lng: 0, lat: 0.01, ...v };
  assert.equal(contacts([a, b]).length, 2);
  assert.equal(contacts([a, { ...b, detruit: true }]).length, 0);
  assert.equal(verifier(a, { type: 'engager', cibleId: 'b' }, { pieces: [a, { ...b, detruit: true }] }).ok, false);
  const tir = avancer(a, { type: 'engager', cibleId: 'b', detruit: true }, 1, [a, b]);
  assert.equal(tir.evenements[0].type, 'tir'); assert.equal(tir.evenements[0].detruit, true);
  assert.equal(avancer(a, { type: 'engager', cibleId: 'b' }, 1, [a, b]).evenements[0].detruit, false);
  assert.equal(avancer(a, { type: 'engager', cibleId: 'b' }, 1, [a, { ...b, detruit: true }]).evenements[0].type, 'cible_perdue');
});

test('contexte : compact, arrondi, avec les consignes en cours', () => {
  const pieces = [{ id: 'd', nom: 'Drone', type: 'uav-arme', camp: 'bleu', lng: 1.123456789, lat: 2.987654321 }];
  const c = contexte({ catalogue, pieces, ordres: { d: [{ statut: 'en_cours' }, { statut: 'terminee' }] }, libelleConsigne: () => 'x' });
  assert.equal(c.pieces[0].lng, 1.1235); assert.deepEqual(c.pieces[0].consignes, ['x']); assert.equal(c.catalogue[0].feu_portee_km, 10);
});

test('les identifiants provisoires du plan deviennent ceux des pièces réellement créées, pièce et cible', () => {
  const plan = planifier(scenario, { pieces: [], catalogue });
  const ids = {};
  [...plan[0].op.specs, ...plan[1].op.specs].forEach((s, i) => { ids[s.vid] = `reel-${i}`; });
  for (const c of plan[2].op.cibles) {
    const r = avecIdsReels(c, ids);
    assert.match(r.ref, /^reel-/); assert.match(r.consigne.cibleId, /^reel-/); assert.equal(r.consigne.detruit, true);
  }
  assert.deepEqual(avecIdsReels({ ref: 'existante', consigne: { type: 'observer' } }, ids), { ref: 'existante', consigne: { type: 'observer' } });
});

test('voix : la dictée s\'ajoute au texte déjà écrit avec une seule espace', () => {
  assert.equal(assembler('', ' bonjour '), 'bonjour'); assert.equal(assembler('pose un drone ', 'à Kiev'), 'pose un drone à Kiev');
  assert.equal(assembler('abc', ''), 'abc'); assert.equal(assembler('', ''), '');
});

test('voix : les silences ne sont pas des erreurs, le micro refusé l\'est', () => {
  assert.equal(messageErreur('no-speech'), null); assert.equal(messageErreur('aborted'), null);
  assert.match(messageErreur('not-allowed'), /micro/);
});
