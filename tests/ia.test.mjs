import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distanceKm } from '../static/geo.js';
import { disposer, planifier, contexte, avecIdsReels, NOMBRE_MAX } from '../static/ia-actions.js';
import { pieceDepuisModele } from '../static/catalogue.js';
import { assembler as assemblerVoix, messageErreur } from '../static/voix.js';
import { contacts, avancer, verifier } from '../static/moteur.js';

const catalogue = JSON.parse(readFileSync(new URL('../static/pieces.json', import.meta.url))).pieces;
const modele = (id) => catalogue.find((m) => m.id === id);
const faire = (id, nom, camp, lng, lat, extra = {}) => ({ ...pieceDepuisModele(modele(id), { id: nom, nom, camp, lng, lat }), ...extra });
const proche = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

const scenario = [
  { action: 'poser', modele: 'equipe-pilotes', camp: 'bleu', lng: 37.4, lat: 48.5 },
  { action: 'poser', modele: 'drone-owa', camp: 'bleu', lng: 37.5, lat: 48.5, nombre: 5, disposition: 'ligne', capDeg: 90 },
  { action: 'poser', modele: 'voiture', camp: 'rouge', lng: 37.8, lat: 48.5, nombre: 5, disposition: 'ligne', capDeg: 270 },
  { action: 'consigne', groupe: { modele: 'drone-owa', camp: 'bleu' }, type: 'engager', cibleGroupe: { modele: 'voiture', camp: 'rouge' } },
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

test('la demande type : équipe de pilotes, 5 drones d\'attaque bleus, 5 voitures rouges, drones qui engagent', () => {
  const plan = planifier(scenario, { pieces: [], catalogue });
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((p) => p.problemes), [[], [], [], []]);
  assert.equal(plan[1].op.specs.length, 5); assert.equal(plan[2].op.specs.length, 5);
  assert.equal(plan[3].op.cibles.length, 5);
  const bleus = new Set(plan[1].op.specs.map((s) => s.vid)), rouges = new Set(plan[2].op.specs.map((s) => s.vid));
  for (const c of plan[3].op.cibles) { assert.ok(bleus.has(c.ref)); assert.ok(rouges.has(c.consigne.cibleId)); assert.equal(c.consigne.detruit, undefined, 'la destruction vient des règles, pas d\'un drapeau'); }
  assert.equal(new Set(plan[3].op.cibles.map((c) => c.consigne.cibleId)).size, 5, 'une cible par drone');
});

test('noms numérotés à la suite des pièces existantes', () => {
  const existantes = [faire('voiture', 'Voiture 1', 'rouge', 0, 0)];
  const plan = planifier([{ action: 'poser', modele: 'voiture', camp: 'rouge', lng: 1, lat: 1, nombre: 2 }], { pieces: existantes, catalogue });
  assert.deepEqual(plan[0].op.specs.map((s) => s.nom), ['Voiture 2', 'Voiture 3']);
});

test('un drone d\'observation ne peut pas engager (aucun feu) : refus expliqué, le drone d\'attaque passe', () => {
  const plan = planifier([
    { action: 'poser', modele: 'equipe-pilotes', camp: 'bleu', lng: 1, lat: 1 },
    { action: 'poser', modele: 'drone-isr', camp: 'bleu', lng: 1.01, lat: 1, nombre: 1 },
    { action: 'poser', modele: 'drone-owa', camp: 'bleu', lng: 1.02, lat: 1, nombre: 1 },
    { action: 'poser', modele: 'voiture', camp: 'rouge', lng: 1.1, lat: 1, nombre: 1 },
    { action: 'consigne', groupe: { camp: 'bleu', modele: 'drone-isr' }, type: 'engager', cible: 'Voiture 1' },
    { action: 'consigne', groupe: { camp: 'bleu', modele: 'drone-owa' }, type: 'engager', cible: 'Voiture 1' },
  ], { pieces: [], catalogue });
  assert.equal(plan[4].op, null); assert.match(plan[4].problemes.join(' '), /aucun feu/);
  assert.equal(plan[5].op.cibles.length, 1);
});

test('refuse sans rien appliquer : modèle inconnu, camp absent, coordonnées folles, trop de pièces', () => {
  const plan = planifier([
    { action: 'poser', modele: 'char-fantome', camp: 'bleu', lng: 1, lat: 1 },
    { action: 'poser', modele: 'voiture', lng: 1, lat: 1 },
    { action: 'poser', modele: 'voiture', camp: 'bleu', lng: 500, lat: 1 },
    { action: 'poser', modele: 'voiture', camp: 'bleu', lng: 1, lat: 1, nombre: NOMBRE_MAX + 1 },
    { action: 'detruire_tout' },
    null,
  ], { pieces: [], catalogue });
  assert.ok(plan.every((p) => p.op === null && p.problemes.length === 1), JSON.stringify(plan));
});

test('une pièce désignée par son nom ambigu ou inconnue est refusée', () => {
  const pieces = [faire('voiture', 'Char', 'bleu', 0, 0, { id: 'a' }), faire('voiture', 'Char', 'bleu', 0, 0.1, { id: 'b' })];
  const plan = planifier([{ action: 'consigne', piece: 'Char', type: 'observer', dureeMin: 5 }, { action: 'consigne', piece: 'Fantôme', type: 'observer', dureeMin: 5 }], { pieces, catalogue });
  assert.match(plan[0].problemes[0], /plusieurs/); assert.match(plan[1].problemes[0], /introuvable/);
});

test('consigne aller : points obligatoires et valides, distance calculée', () => {
  const equipe = faire('equipe-pilotes', 'E', 'bleu', 0, 0), drone = faire('drone-owa', 'd', 'bleu', 0, 0.01, { poste: 'E' });
  const ok = planifier([{ action: 'consigne', piece: 'd', type: 'aller', points: [[0, 0.3]], allure: 'maximale' }], { pieces: [equipe, drone], catalogue });
  proche(ok[0].op.cibles[0].consigne.distanceKm, 32.2, 0.5);
  const ko = planifier([{ action: 'consigne', piece: 'd', type: 'aller', points: [[0, 'x']] }, { action: 'consigne', piece: 'd', type: 'aller' }], { pieces: [equipe, drone], catalogue });
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
  const a = faire('fantassin', 'a', 'bleu', 0, 0), b = faire('fantassin', 'b', 'rouge', 0, 0.002);
  assert.equal(contacts([a, b]).length, 2);
  assert.equal(contacts([a, { ...b, detruit: true }]).length, 0);
  assert.equal(verifier(a, { type: 'engager', cibleId: 'b' }, { pieces: [a, { ...b, detruit: true }] }).ok, false);
  assert.equal(avancer(a, { type: 'engager', cibleId: 'b' }, 1, [a, b]).evenements[0].type, 'tir');
  assert.equal(avancer(a, { type: 'engager', cibleId: 'b' }, 1, [a, { ...b, detruit: true }]).evenements[0].type, 'cible_perdue');
});

test('contexte : compact, arrondi, avec les consignes en cours et l\'état des drones', () => {
  const d = faire('drone-owa', 'd', 'bleu', 1.123456789, 2.987654321);
  const c = contexte({ catalogue, pieces: [d], ordres: { d: [{ statut: 'en_cours' }, { statut: 'terminee' }] }, libelleConsigne: () => 'x' });
  assert.equal(c.pieces[0].lng, 1.1235); assert.deepEqual(c.pieces[0].consignes, ['x']);
  assert.equal(c.pieces[0].etat, 'sol'); assert.equal(c.pieces[0].endurance_restante_min, 60);
  const owa = c.catalogue.find((m) => m.id === 'drone-owa');
  assert.equal(owa.feu, 'explosion'); assert.equal(owa.zone_detruite_m2, 25); assert.equal(owa.portee_operationnelle_km, 50); assert.equal(owa.exige_equipe_de_pilotes, true);
  assert.equal(c.catalogue.find((m) => m.id === 'drone-filoguide').insensible_au_brouillage, true);
  assert.equal(c.catalogue.find((m) => m.id === 'brouilleur').brouillage_rayon_km, 4);
});

test('les identifiants provisoires du plan deviennent ceux des pièces réellement créées, pièce et cible', () => {
  const plan = planifier(scenario, { pieces: [], catalogue });
  const ids = {};
  [...plan[1].op.specs, ...plan[2].op.specs].forEach((s, i) => { ids[s.vid] = `reel-${i}`; });
  for (const c of plan[3].op.cibles) {
    const r = avecIdsReels(c, ids);
    assert.match(r.ref, /^reel-/); assert.match(r.consigne.cibleId, /^reel-/);
  }
  assert.deepEqual(avecIdsReels({ ref: 'existante', consigne: { type: 'observer' } }, ids), { ref: 'existante', consigne: { type: 'observer' } });
});

test('voix : la dictée s\'ajoute au texte déjà écrit avec une seule espace', () => {
  assert.equal(assemblerVoix('', ' bonjour '), 'bonjour'); assert.equal(assemblerVoix('pose un drone ', 'à Kiev'), 'pose un drone à Kiev');
  assert.equal(assemblerVoix('abc', ''), 'abc'); assert.equal(assemblerVoix('', ''), '');
});

test('voix : les silences ne sont pas des erreurs, le micro refusé l\'est', () => {
  assert.equal(messageErreur('no-speech'), null); assert.equal(messageErreur('aborted'), null);
  assert.match(messageErreur('not-allowed'), /micro/);
});
