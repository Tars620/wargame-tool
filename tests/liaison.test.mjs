import test from 'node:test';
import assert from 'node:assert/strict';
import { destination, distanceKm } from '../static/geo.js';
import { etatLiaison, lierAuto, verifier, phraseLiaison } from '../static/moteur.js';
import { planifier } from '../static/ia-actions.js';
import { valider, assembler } from '../static/scenario.js';

const O = [37.5, 48.5];
const poste = (id, camp = 'bleu', at = O, extra = {}) => ({ id, nom: `PC ${id}`, type: 'poste-commandement', camp, lng: at[0], lat: at[1], commande: { portee_km: 30 },
  mouvement: { min: 20, max: 50 }, feu: { portee_km: 0, puissance: 0 }, vision: { rayon_km: 3 }, ...extra });
const drone = (id, camp = 'bleu', at = O, extra = {}) => ({ id, nom: `Drone ${id}`, type: 'uav-arme', camp, lng: at[0], lat: at[1], liaison: true,
  mouvement: { min: 60, max: 150 }, feu: { portee_km: 10, puissance: 4 }, vision: { rayon_km: 8 }, ...extra });
const cible = (id, at) => ({ id, nom: `Cible ${id}`, type: 'blinde', camp: 'rouge', lng: at[0], lat: at[1], mouvement: { min: 50, max: 70 }, feu: { portee_km: 3, puissance: 6 }, vision: { rayon_km: 3 } });
const a = (km, cap = 90, de = O) => destination(de, cap, km);

test('un poste, plusieurs drones : chacun est rattaché au poste le plus proche qui le couvre', () => {
  const pieces = [poste('p1', 'bleu', O), poste('p2', 'bleu', a(100)), drone('d1', 'bleu', a(10)), drone('d2', 'bleu', a(20, 0)), drone('d3', 'bleu', a(95))];
  assert.deepEqual(lierAuto(pieces), { d1: 'p1', d2: 'p1', d3: 'p2' });
});

test('pas de poste à portée, poste d\'un autre camp ou détruit : aucun rattachement', () => {
  assert.deepEqual(lierAuto([poste('p1', 'bleu', a(31)), drone('d1')]), {});
  assert.deepEqual(lierAuto([poste('p1', 'rouge'), drone('d1')]), {});
  assert.deepEqual(lierAuto([poste('p1', 'bleu', O, { detruit: true }), drone('d1')]), {});
});

test('un lien existant n\'est pas défait ; un poste détruit n\'est pas remplacé d\'office', () => {
  const pieces = [poste('p1', 'bleu', O, { detruit: true }), poste('p2', 'bleu', a(5)), drone('d1', 'bleu', a(2), { poste: 'p1' })];
  assert.deepEqual(lierAuto(pieces), {});
  assert.equal(etatLiaison(pieces[2], pieces).raison, 'detruit');
});

test('état de liaison : établie, hors portée, sans poste', () => {
  const p = poste('p1');
  const ok = drone('d1', 'bleu', a(29.9), { poste: 'p1' }), loin = drone('d2', 'bleu', a(30.5), { poste: 'p1' }), seul = drone('d3');
  assert.equal(etatLiaison(ok, [p, ok]).ok, true);
  const l = etatLiaison(loin, [p, loin]);
  assert.equal(l.ok, false); assert.equal(l.raison, 'hors_portee'); assert.match(phraseLiaison(l), /30,5 km.*30,0 km au plus/);
  assert.equal(etatLiaison(seul, [p, seul]).raison, 'aucun');
  assert.deepEqual(etatLiaison(cible('c', O), []), { requise: false, ok: true, raison: null });
});

test('consigne aller : refusée si la destination est à plus de 30 km du poste, acceptée sinon', () => {
  const p = poste('p1'), d = drone('d1', 'bleu', a(5), { poste: 'p1' });
  assert.equal(verifier(d, { type: 'aller', points: [a(25)], allure: 'normale' }, { pieces: [p, d] }).ok, true);
  const r = verifier(d, { type: 'aller', points: [a(25), a(35)], allure: 'normale' }, { pieces: [p, d] });
  assert.equal(r.ok, false); assert.match(r.erreurs[0], /35,0 km de son poste de commandement \(30,0 km au plus\)/);
});

test('consigne engager : le point d\'arrêt (portée de feu de la cible) doit rester dans la portée du poste', () => {
  const p = poste('p1'), d = drone('d1', 'bleu', a(5), { poste: 'p1' });
  assert.equal(verifier(d, { type: 'engager', cibleId: 'c1' }, { pieces: [p, d, cible('c1', a(35))] }).ok, true, 'arrêt à 25 km du poste');
  const loin = verifier(d, { type: 'engager', cibleId: 'c1' }, { pieces: [p, d, cible('c1', a(60))] });
  assert.equal(loin.ok, false); assert.match(loin.erreurs[0], /s'éloigner/);
});

test('un drone sans poste, ou dont la liaison est coupée, ne reçoit aucune consigne, même observer', () => {
  const p = poste('p1');
  const sans = verifier(drone('d1'), { type: 'observer', dureeMin: 5 }, { pieces: [p, drone('d1')] });
  assert.equal(sans.ok, false); assert.match(sans.erreurs[0], /aucun poste de commandement/);
  const coupe = drone('d2', 'bleu', a(40), { poste: 'p1' });
  assert.match(verifier(coupe, { type: 'observer', dureeMin: 5 }, { pieces: [p, coupe] }).erreurs[0], /40,0 km/);
  const detruit = poste('p1', 'bleu', O, { detruit: true }), d = drone('d3', 'bleu', a(1), { poste: 'p1' });
  assert.match(verifier(d, { type: 'observer', dureeMin: 5 }, { pieces: [detruit, d] }).erreurs[0], /détruit/);
});

test('déplacer le poste avertit des drones qui sortiraient de sa portée', () => {
  const p = poste('p1'), d1 = drone('d1', 'bleu', a(10), { poste: 'p1' }), d2 = drone('d2', 'bleu', a(12, 0), { poste: 'p1' });
  const r = verifier(p, { type: 'aller', points: [a(45, 270)], allure: 'normale' }, { pieces: [p, d1, d2] });
  assert.equal(r.ok, true); assert.match(r.avertissements.join(' '), /2 drones rattachés à ce poste seront hors de portée/);
  assert.deepEqual(verifier(p, { type: 'aller', points: [a(2, 270)], allure: 'normale' }, { pieces: [p, d1, d2] }).avertissements, []);
});

const catalogue = [
  { id: 'poste-commandement', nom: 'Poste de commandement', mouvement: { min: 20, max: 50 }, feu: { portee_km: 0, puissance: 0 }, vision: { rayon_km: 3 }, commande: { portee_km: 30 } },
  { id: 'uav-arme', nom: 'UAV armé', mouvement: { min: 60, max: 150 }, feu: { portee_km: 10, puissance: 4 }, vision: { rayon_km: 8 }, liaison: true },
  { id: 'blinde', nom: 'Véhicule blindé', mouvement: { min: 50, max: 70 }, feu: { portee_km: 3, puissance: 6 }, vision: { rayon_km: 3 } },
];

test('assistant : poste puis 5 drones rattachés, consignes acceptées dans la portée', () => {
  const plan = planifier([
    { action: 'poser', modele: 'poste-commandement', camp: 'bleu', lng: O[0] - 0.1, lat: O[1] },
    { action: 'poser', modele: 'uav-arme', camp: 'bleu', lng: O[0], lat: O[1], nombre: 5, disposition: 'ligne', capDeg: 90 },
    { action: 'consigne', groupe: { modele: 'uav-arme', camp: 'bleu' }, type: 'aller', points: [[O[0] + 0.1, O[1]]] },
  ], { pieces: [], catalogue });
  assert.deepEqual(plan.map((p) => p.problemes), [[], [], []]);
  assert.deepEqual(plan[1].avertissements, []);
  assert.equal(plan[2].op.cibles.length, 5);
});

test('assistant : des drones sans poste sont signalés et leurs consignes refusées', () => {
  const plan = planifier([
    { action: 'poser', modele: 'uav-arme', camp: 'bleu', lng: O[0], lat: O[1], nombre: 3 },
    { action: 'consigne', groupe: { modele: 'uav-arme', camp: 'bleu' }, type: 'observer', dureeMin: 5 },
  ], { pieces: [], catalogue });
  assert.match(plan[0].avertissements[0], /3 drones sans poste de commandement/);
  assert.equal(plan[1].op, null); assert.match(plan[1].problemes.join(' '), /aucun poste de commandement/);
});

test('assistant : une destination qui éloigne les drones de plus de 30 km du poste est refusée', () => {
  const plan = planifier([
    { action: 'poser', modele: 'poste-commandement', camp: 'bleu', lng: O[0], lat: O[1] },
    { action: 'poser', modele: 'uav-arme', camp: 'bleu', lng: O[0] + 0.05, lat: O[1], nombre: 2 },
    { action: 'consigne', groupe: { modele: 'uav-arme' }, type: 'aller', points: [a(50)] },
  ], { pieces: [], catalogue });
  assert.equal(plan[2].op, null); assert.match(plan[2].problemes.join(' '), /de son poste de commandement/);
});

test('assistant : rattacher refuse un poste trop loin ou d\'un autre camp, accepte sinon', () => {
  const pieces = [poste('p1'), poste('p2', 'bleu', a(100)), poste('p3', 'rouge'), drone('d1', 'bleu', a(10), { poste: 'p1' })];
  const [loin, rouge, ok] = planifier([
    { action: 'rattacher', piece: 'd1', poste: 'p2' }, { action: 'rattacher', piece: 'd1', poste: 'p3' }, { action: 'rattacher', piece: 'd1', poste: 'p1' }], { pieces, catalogue });
  assert.equal(loin.op, null); assert.match(loin.problemes.join(' '), /plus de 30 km/);
  assert.equal(rouge.op, null); assert.match(rouge.problemes.join(' '), /autre camp/);
  assert.deepEqual(ok.op.liens, [{ ref: 'd1', poste: 'p1' }]);
});

test('scénario : les liaisons, la portée du poste et la destruction survivent à l\'enregistrement', () => {
  const base = { id: 'p', type: 'poste-commandement', nom: 'PC', camp: 'bleu', lng: 1, lat: 2, mouvement: { min: 1, max: 2 }, feu: { portee_km: 0, puissance: 0 }, vision: { rayon_km: 3 }, commande: { portee_km: 30 } };
  const d = { id: 'd', type: 'uav-arme', nom: 'D', camp: 'bleu', lng: 1, lat: 2, mouvement: { min: 1, max: 2 }, feu: { portee_km: 1, puissance: 1 }, vision: { rayon_km: 3 }, liaison: true, poste: 'p', detruit: true };
  const r = valider(JSON.parse(JSON.stringify(assembler({ pieces: [base, d], dessins: [], ordres: { d: [{ id: 'c', type: 'engager', statut: 'lance', cibleId: 'x', detruit: true }] }, journal: [] }))));
  assert.equal(r.ok, true, r.erreur);
  assert.deepEqual(r.scenario.pieces[0].commande, { portee_km: 30 });
  assert.equal(r.scenario.pieces[1].poste, 'p'); assert.equal(r.scenario.pieces[1].liaison, true); assert.equal(r.scenario.pieces[1].detruit, true);
  assert.equal(r.scenario.ordres.d[0].detruit, true);
  assert.equal(valider({ ...assembler({ pieces: [{ ...d, poste: 42 }] }) }).ok, false);
});

test('distances de vérité : le décalage de 30 km est bien de 30 km', () => { assert.ok(Math.abs(distanceKm(O, a(30)) - 30) < 0.01); });
