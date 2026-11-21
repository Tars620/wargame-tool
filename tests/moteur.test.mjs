import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, capVers, pointVers } from '../static/geo.js';
import { vitesse, verifier, avancer, contacts, visiblesPour } from '../static/moteur.js';

const proche = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tolérance ${tol})`);
const piece = (id, camp, lng, lat, extra = {}) => ({ id, camp, lng, lat, mouvement: { min: 60, max: 120 }, feu: { portee_km: 0, puissance: 0 }, vision: { rayon_km: 15 }, ...extra });
const drone = piece('d1', 'bleu', 17, 47);
const artillerie = piece('a1', 'rouge', 17, 47.5, { mouvement: { min: 30, max: 60 }, feu: { portee_km: 30, puissance: 8 }, vision: { rayon_km: 1 } });

test('cap : nord 0, est 90, sud 180, ouest 270', () => {
  proche(capVers([0, 0], [0, 1]), 0, 1e-6); proche(capVers([0, 0], [1, 0]), 90, 1e-6);
  proche(capVers([0, 0], [0, -1]), 180, 1e-6); proche(capVers([0, 0], [-1, 0]), 270, 1e-6);
});

test('pointVers avance de la distance demandée, sans dépasser le but', () => {
  proche(distanceKm([0, 0], pointVers([0, 0], [1, 0], 50)), 50, 0.01);
  assert.deepEqual(pointVers([0, 0], [0.1, 0], 500), [0.1, 0]);
});

test('vitesse selon l\'allure : prudente = min, normale = moyenne, maximale = max', () => {
  assert.equal(vitesse(drone, 'prudente'), 60); assert.equal(vitesse(drone, 'normale'), 90); assert.equal(vitesse(drone, 'maximale'), 120);
});

test('aller : distance et durée d\'après la vitesse de la pièce', () => {
  const r = verifier(drone, { type: 'aller', points: [[17, 48]], allure: 'maximale' });
  assert.ok(r.ok); proche(r.distanceKm, 111.2, 0.5); proche(r.dureeMin, 55.6, 0.3);
});

test('une pièce immobile ne peut pas recevoir d\'ordre de déplacement', () => {
  const statue = piece('s', 'bleu', 0, 0, { mouvement: { min: 0, max: 0 } });
  const r = verifier(statue, { type: 'aller', points: [[0, 1]] });
  assert.equal(r.ok, false); assert.match(r.erreurs[0], /ne peut pas se déplacer/);
});

test('engager : refusé sans feu, sans cible, ou contre son propre camp', () => {
  const autre = piece('b2', 'bleu', 17, 47.1);
  assert.match(verifier(drone, { type: 'engager', cibleId: 'a1' }, { pieces: [drone, artillerie] }).erreurs[0], /aucun feu/);
  assert.match(verifier(artillerie, { type: 'engager', cibleId: 'zz' }, { pieces: [artillerie] }).erreurs.join(), /cible/i);
  assert.match(verifier({ ...drone, feu: { portee_km: 5, puissance: 1 } }, { type: 'engager', cibleId: 'b2' }, { pieces: [drone, autre] }).erreurs.join(), /même camp/);
});

test('engager hors de portée : accepté avec avertissement et durée d\'approche', () => {
  const tireur = piece('t', 'bleu', 17, 47, { feu: { portee_km: 10, puissance: 4 } });
  const r = verifier(tireur, { type: 'engager', cibleId: 'a1', allure: 'maximale' }, { pieces: [tireur, artillerie] });
  assert.ok(r.ok); assert.match(r.avertissements[0], /hors de portée/); assert.ok(r.dureeMin > 0);
});

test('météo : un vent au-dessus de la limite de la pièce est signalé, sans interdire', () => {
  const uav = { ...drone, meteo_max: { vent_kmh: 45 } };
  const r = verifier(uav, { type: 'aller', points: [[17, 47.1]] }, { meteo: { vent_kmh: 52 } });
  assert.ok(r.ok); assert.match(r.avertissements[0], /52 km\/h.*45 km\/h/);
  assert.equal(verifier(uav, { type: 'aller', points: [[17, 47.1]] }, { meteo: { vent_kmh: 30 } }).avertissements.length, 0);
});

test('avancer : une heure à 60 km/h fait 60 km, la consigne continue', () => {
  const p = piece('p', 'bleu', 0, 0, { mouvement: { min: 60, max: 60 } });
  const r = avancer(p, { type: 'aller', points: [[1, 0]], allure: 'normale' }, 60);
  proche(distanceKm([0, 0], r.position), 60, 0.01); assert.equal(r.termine, false);
});

test('avancer : on s\'arrête exactement à destination et l\'arrivée est signalée', () => {
  const p = piece('p', 'bleu', 0, 0, { mouvement: { min: 100, max: 100 } });
  const r = avancer(p, { type: 'aller', points: [[0.1, 0]], allure: 'normale' }, 600);
  assert.deepEqual(r.position, [0.1, 0]); assert.ok(r.termine); assert.equal(r.evenements[0].type, 'arrivee');
});

test('avancer : un itinéraire à plusieurs points est suivi dans l\'ordre', () => {
  const p = piece('p', 'bleu', 0, 0, { mouvement: { min: 111.195, max: 111.195 } });
  const consigne = { type: 'aller', points: [[1, 0], [1, 1]], allure: 'normale' };
  const mi = avancer(p, consigne, 90);                                // 166,8 km : 1° est puis 0,5° nord
  proche(mi.position[0], 1, 0.01); proche(mi.position[1], 0.5, 0.01); assert.equal(mi.termine, false);
  assert.equal(mi.consigne.etape, 1);
});

test('observer : se termine après la durée demandée', () => {
  const a = avancer(drone, { type: 'observer', dureeMin: 10 }, 6);
  assert.equal(a.termine, false);
  assert.ok(avancer(drone, a.consigne, 6).termine);
});

test('engager : approche jusqu\'à la portée puis tire une seule fois, résultat à arbitrer', () => {
  const tireur = piece('t', 'bleu', 17, 47, { mouvement: { min: 120, max: 120 }, feu: { portee_km: 10, puissance: 4 } });
  let etat = tireur, consigne = { type: 'engager', cibleId: 'a1', allure: 'normale' }, evts = [];
  for (let i = 0; i < 200 && !evts.length; i += 1) {
    const r = avancer(etat, consigne, 1, [etat, artillerie]);
    etat = { ...etat, lng: r.position[0], lat: r.position[1] }; consigne = r.consigne; evts = r.evenements;
  }
  assert.equal(evts[0].type, 'tir'); assert.ok(evts[0].distanceKm <= 10); assert.equal(evts[0].puissance, 4);
});

test('engager une cible disparue : consigne close avec un événement', () => {
  const r = avancer({ ...artillerie, id: 't' }, { type: 'engager', cibleId: 'disparu' }, 1, []);
  assert.ok(r.termine); assert.equal(r.evenements[0].type, 'cible_perdue');
});

test('contacts : l\'adversaire dans le rayon de vision est vu, l\'allié et le lointain non', () => {
  const proche15 = piece('r1', 'rouge', 17, 47.1), loin = piece('r2', 'rouge', 17, 48), ami = piece('b2', 'bleu', 17, 47.01);
  const c = contacts([drone, proche15, loin, ami]);
  const paires = c.map((x) => `${x.observateurId}>${x.cibleId}`).sort();
  assert.deepEqual(paires, ['b2>r1', 'd1>r1', 'r1>b2', 'r1>d1']);
  assert.ok(!paires.some((p) => p.includes('r2')), 'r2 est hors de toute vision');
  assert.ok(!paires.includes('d1>b2'), 'deux alliés ne sont pas des contacts');
});

test('visibilité : un camp voit les siens et ce que voient ses pièces, pas le reste', () => {
  const r1 = piece('r1', 'rouge', 17, 47.1), r2 = piece('r2', 'rouge', 17, 48);
  assert.deepEqual([...visiblesPour('bleu', [drone, r1, r2])].sort(), ['d1', 'r1']);
});
