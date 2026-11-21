import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { destination, distanceKm } from '../static/geo.js';
import { bruit, doitRentrer, effets, enduranceRestante, impactZone, peutDetruire, rayonVision, minutesRetour, rayonDeSurfaceM } from '../static/regles.js';
import { avancer, contacts, verifier, vitesse } from '../static/moteur.js';
import { migrerPieces, pieceDepuisModele } from '../static/catalogue.js';
import { assembler, valider } from '../static/scenario.js';

const catalogue = JSON.parse(readFileSync(new URL('../static/pieces.json', import.meta.url))).pieces;
const modele = (id) => catalogue.find((m) => m.id === id);
const O = [37.5, 48.5];
const a = (km, cap = 90, de = O) => destination(de, cap, km);
const faire = (id, nom, camp, at, extra = {}) => ({ ...pieceDepuisModele(modele(id), { id: nom, nom, camp, lng: at[0], lat: at[1] }), ...extra });
const proche = (x, y, tol) => assert.ok(Math.abs(x - y) <= tol, `${x} vs ${y}`);

test('unités : la surface d\'observation d\'un drone devient le rayon du disque équivalent', () => {
  proche(rayonVision({ surface_km2: 1 }), 0.5642, 1e-3); proche(rayonVision({ surface_km2: 2 }), 0.7979, 1e-3);
  assert.equal(rayonVision({ rayon_km: 1 }), 1); assert.equal(rayonVision({ surface_km2: 0, rayon_km: 3 }), 3);
  proche(rayonDeSurfaceM(25), 2.82, 0.01);
});

test('le catalogue reprend les valeurs documentées', () => {
  const m = (id) => modele(id);
  assert.deepEqual([m('drone-isr').mouvement.max, m('drone-isr').endurance_min, m('drone-isr').portee_op_km, m('drone-isr').vision.surface_km2, m('drone-isr').feu.mode], [70, 45, 20, 1, 'aucun']);
  assert.deepEqual([m('drone-owa').mouvement.max, m('drone-owa').endurance_min, m('drone-owa').portee_op_km, m('drone-owa').vision.surface_km2, m('drone-owa').feu.zone_m2], [120, 60, 50, 2, 25]);
  assert.deepEqual([m('brouilleur').mouvement.max, m('brouilleur').brouillage.rayon_km], [2, 4]);
  assert.deepEqual([m('fantassin').mouvement.min, m('fantassin').mouvement.max, m('fantassin').vision.rayon_km, m('fantassin').feu.portee_km], [4, 4, 1, 0.3]);
  assert.deepEqual([m('artillerie').mouvement.min, m('artillerie').mouvement.max, m('artillerie').route_seule], [30, 50, true]);
  assert.equal(m('drone-filoguide').immunise_brouillage, true);
  assert.ok(m('drone-filoguide').portee_op_km < m('drone-owa').portee_op_km && m('drone-filoguide').endurance_min < m('drone-owa').endurance_min);
});

test('qui détruit qui : le fantassin seulement fantassins et brouilleurs, le drone d\'attaque tout le sol sauf les drones, le drone d\'observation rien', () => {
  const f = faire('fantassin', 'f', 'bleu', O);
  const cat = (id) => faire(id, id, 'rouge', O);
  assert.deepEqual(['fantassin', 'brouilleur', 'voiture', 'moto', 'artillerie', 'drone-owa', 'equipe-pilotes'].map((id) => peutDetruire(f, cat(id))), [true, true, false, false, false, false, false]);
  const owa = faire('drone-owa', 'o', 'bleu', O);
  assert.deepEqual(['fantassin', 'brouilleur', 'voiture', 'artillerie', 'equipe-pilotes', 'drone-isr', 'drone-owa'].map((id) => peutDetruire(owa, cat(id))), [true, true, true, true, true, false, false]);
  assert.equal(peutDetruire(faire('drone-isr', 'i', 'bleu', O), cat('fantassin')), false);
  assert.equal(peutDetruire(faire('voiture', 'v', 'bleu', O), cat('fantassin')), false);
});

test('frappe : le drone d\'attaque se détruit, détruit sa cible et ce qui est dans 25 m², pas ce qui est plus loin', () => {
  const owa = faire('drone-owa', 'o', 'bleu', a(10)), cible = faire('voiture', 'c', 'rouge', O), pres = faire('fantassin', 'p', 'rouge', a(0.002, 0, O)), loin = faire('fantassin', 'l', 'rouge', a(0.01, 0, O));
  const e = { type: 'frappe', pieceId: 'o', cibleId: 'c', impact: O, rayonM: rayonDeSurfaceM(25) };
  const ids = effets(e, [owa, cible, pres, loin]).map((x) => `${x.id}:${x.cause}`).sort();
  assert.deepEqual(ids, ['c:explosion', 'o:explosion', 'p:explosion']);
  const ami = faire('fantassin', 'ami', 'bleu', a(0.001, 0, O));
  assert.ok(effets(e, [owa, cible, ami]).some((x) => x.id === 'ami'), 'le tir ami existe : l\'explosion ne choisit pas son camp');
  assert.deepEqual(effets(e, [owa, { ...cible, detruit: true }]).map((x) => x.id), ['o'], 'une pièce déjà détruite n\'est pas détruite deux fois');
});

test('une frappe ne détruit pas un drone en vol à côté (catégorie non visée)', () => {
  const owa = faire('drone-owa', 'o', 'bleu', a(10)), voisin = faire('drone-isr', 'i', 'rouge', O);
  assert.deepEqual(effets({ type: 'frappe', pieceId: 'o', cibleId: 'i', impact: O, rayonM: 2.82 }, [owa, voisin]).map((x) => x.id), ['o']);
});

test('tir de zone : toute pièce du sol dans le rayon, rien au-delà ; le tir direct ne touche que sa cible permise', () => {
  const art = faire('artillerie', 'a', 'bleu', a(15, 180)), dedans = faire('voiture', 'v', 'rouge', a(0.04, 0, O)), dehors = faire('voiture', 'w', 'rouge', a(0.08, 0, O));
  const e = { type: 'tir_zone', pieceId: 'a', cibleId: 'v', impact: O, rayonM: 50 };
  assert.deepEqual(effets(e, [art, dedans, dehors]).map((x) => `${x.id}:${x.cause}`), ['v:artillerie']);
  const f = faire('fantassin', 'f', 'bleu', O), ennemi = faire('fantassin', 'e', 'rouge', a(0.1)), voiture = faire('voiture', 'x', 'rouge', a(0.1));
  assert.deepEqual(effets({ type: 'tir', pieceId: 'f', cibleId: 'e' }, [f, ennemi]).map((x) => x.id), ['e']);
  assert.deepEqual(effets({ type: 'tir', pieceId: 'f', cibleId: 'x' }, [f, voiture]), []);
});

test('impact de zone : déterministe, centré, dispersion de la bonne ampleur (médiane de Rayleigh = 1,18 σ)', () => {
  assert.deepEqual(impactZone(O, 30, 'g'), impactZone(O, 30, 'g')); assert.notDeepEqual(impactZone(O, 30, 'g'), impactZone(O, 30, 'h'));
  assert.deepEqual(impactZone(O, 0, 'x'), O);
  const ecarts = Array.from({ length: 4000 }, (_, i) => distanceKm(impactZone(O, 30, `s${i}`), O) * 1000).sort((x, y) => x - y);
  proche(ecarts[2000], 1.1774 * 30, 3);
  assert.ok(bruit('a') >= 0 && bruit('a') < 1 && bruit('a') === bruit('a'));
});

test('endurance : retour obligatoire quand il ne reste que le temps de rentrer, marge de 10 % comprise', () => {
  const equipe = faire('equipe-pilotes', 'e', 'bleu', O);
  const isr = (km, restante) => faire('drone-isr', 'i', 'bleu', a(km), { etat: 'vol', endurance_restante_min: restante, poste: 'e' });
  assert.equal(enduranceRestante(faire('drone-isr', 'i', 'bleu', O)), 45);
  const retour = minutesRetour(isr(10, 45), equipe, 52.5); // 10 km à 52,5 km/h = 11,43 min, +10 %
  proche(retour, 12.57, 0.05);
  assert.equal(doitRentrer(isr(10, 13), equipe, 52.5), false); assert.equal(doitRentrer(isr(10, 12), equipe, 52.5), true);
  assert.equal(doitRentrer(faire('drone-owa', 'o', 'bleu', a(10), { etat: 'vol', endurance_restante_min: 1 }), equipe, 90), false, 'un drone à sens unique ne rentre pas');
  assert.equal(doitRentrer(faire('drone-isr', 'i', 'bleu', a(10), { etat: 'sol', endurance_restante_min: 1 }), equipe, 52.5), false, 'au sol, rien à décompter');
});

test('mission trop longue pour l\'endurance : refusée avec le détail (vol + retour)', () => {
  const e = faire('equipe-pilotes', 'e', 'bleu', O), d = faire('drone-isr', 'd', 'bleu', O, { poste: 'e' });
  const lent = verifier(d, { type: 'aller', allure: 'prudente', points: [a(19)] }, { pieces: [e, d] });
  assert.equal(lent.ok, false); assert.match(lent.erreurs[0], /Endurance insuffisante : 32,6 min de vol \+ 35,8 min pour rentrer, pour 45 min restantes/);
  assert.equal(verifier(d, { type: 'aller', allure: 'maximale', points: [a(19)] }, { pieces: [e, d] }).ok, true);
  assert.equal(verifier(d, { type: 'observer', dureeMin: 60 }, { pieces: [e, d] }).ok, false);
  assert.equal(verifier(d, { type: 'observer', dureeMin: 40 }, { pieces: [e, d] }).ok, true);
});

test('drone d\'attaque : la cible doit être atteignable avant la fin de l\'endurance et dans la portée opérationnelle ; le filoguidé a moins de portée', () => {
  const e = faire('equipe-pilotes', 'e', 'bleu', O), cible = (km) => faire('voiture', 'c', 'rouge', a(km));
  const owa = faire('drone-owa', 'd', 'bleu', O, { poste: 'e' }), fil = faire('drone-filoguide', 'f', 'bleu', O, { poste: 'e' });
  assert.equal(verifier(owa, { type: 'engager', cibleId: 'c' }, { pieces: [e, owa, cible(45)] }).ok, true);
  assert.match(verifier(owa, { type: 'engager', cibleId: 'c' }, { pieces: [e, owa, cible(55)] }).erreurs[0], /50,0 km au plus/);
  assert.equal(verifier(fil, { type: 'engager', cibleId: 'c' }, { pieces: [e, fil, cible(24)] }).ok, true);
  assert.match(verifier(fil, { type: 'engager', cibleId: 'c' }, { pieces: [e, fil, cible(26)] }).erreurs[0], /25,0 km au plus/);
  const trop = { ...owa, endurance_restante_min: 5 };
  assert.match(verifier(trop, { type: 'engager', cibleId: 'c' }, { pieces: [e, trop, cible(30)] }).erreurs[0], /Endurance insuffisante/);
});

test('catégories : un fantassin ne vise pas une voiture, un drone d\'observation ne tire pas, rentrer seulement pour qui rentre', () => {
  const f = faire('fantassin', 'f', 'bleu', O), v = faire('voiture', 'v', 'rouge', a(0.1)), b = faire('brouilleur', 'b', 'rouge', a(0.1)), e = faire('equipe-pilotes', 'e', 'bleu', O);
  assert.match(verifier(f, { type: 'engager', cibleId: 'v' }, { pieces: [f, v] }).erreurs[0], /ne peut pas détruire un véhicule/);
  assert.equal(verifier(f, { type: 'engager', cibleId: 'b' }, { pieces: [f, b] }).ok, true);
  const isr = faire('drone-isr', 'i', 'bleu', O, { poste: 'e' }), owa = faire('drone-owa', 'o', 'bleu', O, { poste: 'e' });
  assert.match(verifier(isr, { type: 'engager', cibleId: 'v' }, { pieces: [e, isr, v] }).erreurs[0], /aucun feu/);
  assert.equal(verifier(isr, { type: 'rentrer' }, { pieces: [e, isr] }).ok, true);
  assert.match(verifier(owa, { type: 'rentrer' }, { pieces: [e, owa] }).erreurs[0], /sens unique/);
  assert.match(verifier(f, { type: 'rentrer' }, { pieces: [f] }).erreurs[0], /drone d'observation/);
});

test('brouilleur : avertissement si la trajectoire traverse sa zone, sauf pour le drone filoguidé', () => {
  const e = faire('equipe-pilotes', 'e', 'bleu', O), j = faire('brouilleur', 'j', 'rouge', a(20)), c = faire('voiture', 'c', 'rouge', a(40));
  const owa = faire('drone-owa', 'd', 'bleu', O, { poste: 'e' }), fil = faire('drone-filoguide', 'f', 'bleu', O, { poste: 'e' });
  assert.match(verifier(owa, { type: 'aller', points: [a(24)] }, { pieces: [e, owa, j] }).avertissements.join(' '), /zone de brouillage de j \(4,0 km\)/);
  assert.deepEqual(verifier(fil, { type: 'aller', points: [a(24)] }, { pieces: [e, fil, j] }).avertissements, []);
  assert.deepEqual(verifier(owa, { type: 'aller', points: [a(24, 0)] }, { pieces: [e, owa, j, c] }).avertissements, [], 'trajectoire hors de la zone');
});

test('avancer : le drone d\'attaque fonce sur sa cible et explose (frappe), l\'artillerie tire une fois avec dispersion', () => {
  const owa = faire('drone-owa', 'd', 'bleu', O), cible = faire('voiture', 'c', 'rouge', a(3));
  let etat = owa, evts = [], r;
  for (let i = 0; i < 20 && !evts.length; i += 1) { r = avancer(etat, { type: 'engager', cibleId: 'c', allure: 'maximale' }, 0.5, [etat, cible]); etat = { ...etat, lng: r.position[0], lat: r.position[1] }; evts = r.evenements; }
  assert.equal(evts[0].type, 'frappe'); assert.deepEqual(evts[0].impact, [cible.lng, cible.lat]); proche(evts[0].rayonM, 2.82, 0.01); assert.ok(r.termine);
  const art = faire('artillerie', 'a', 'bleu', a(10, 180)), v = faire('voiture', 'v', 'rouge', O);
  const t1 = avancer(art, { type: 'engager', cibleId: 'v', allure: 'normale' }, 1, [art, v], 'g1'), t2 = avancer(art, { type: 'engager', cibleId: 'v', allure: 'normale' }, 1, [art, v], 'g1');
  assert.equal(t1.evenements[0].type, 'tir_zone'); assert.deepEqual(t1.evenements, t2.evenements, 'même graine, même impact');
  assert.equal(t1.evenements[0].rayonM, 50); assert.ok(distanceKm(t1.evenements[0].impact, O) * 1000 < 200);
});

test('avancer rentrer : le drone se pose sur son équipe', () => {
  const e = faire('equipe-pilotes', 'e', 'bleu', O), d = faire('drone-isr', 'd', 'bleu', a(2), { etat: 'vol', poste: 'e' });
  let etat = d, evts = [];
  for (let i = 0; i < 30 && !evts.length; i += 1) { const r = avancer(etat, { type: 'rentrer', allure: 'normale' }, 0.5, [e, etat]); etat = { ...etat, lng: r.position[0], lat: r.position[1] }; evts = r.evenements; }
  assert.equal(evts[0].type, 'atterri'); assert.deepEqual([etat.lng, etat.lat], O);
});

test('observation : un drone au sol ne voit rien, en vol il voit sa surface équivalente (1 km² = 564 m de rayon)', () => {
  const sol = faire('drone-isr', 'd', 'bleu', O), vol = { ...sol, etat: 'vol' }, cible = faire('fantassin', 'c', 'rouge', a(0.5)), loin = faire('fantassin', 'l', 'rouge', a(0.6));
  assert.deepEqual(contacts([sol, cible]).filter((x) => x.observateurId === 'd'), []);
  assert.equal(contacts([vol, cible]).filter((x) => x.observateurId === 'd').length, 1);
  assert.equal(contacts([vol, loin]).filter((x) => x.observateurId === 'd').length, 0);
});

test('catalogue : une pièce neuve ne partage rien avec son modèle, au sol et pleine d\'endurance', () => {
  const m = modele('drone-owa'), p = pieceDepuisModele(m, { id: 'x', nom: 'N', camp: 'bleu', lng: 1, lat: 2 });
  p.feu.cibles.push('piège'); p.vision.surface_km2 = 99;
  assert.ok(!m.feu.cibles.includes('piège')); assert.equal(m.vision.surface_km2, 2);
  assert.equal(p.etat, 'sol'); assert.equal(p.endurance_restante_min, 60); proche(pieceDepuisModele(m, { id: 'y', nom: 'N', camp: 'bleu', lng: 1, lat: 2 }).vision.rayon_km, 0.7979, 1e-3);
  assert.equal(vitesse(p, 'maximale'), 120);
});

test('migration : l\'ancien catalogue est reconstruit sur le nouveau (identité, camp, position, équipe, état), sans équivalent retiré', () => {
  const ancien = (type, nom, extra = {}) => ({ id: `id-${nom}`, type, nom, camp: 'bleu', lng: 1, lat: 2, mouvement: { min: 1, max: 2 }, feu: { portee_km: 10, puissance: 4 }, vision: { rayon_km: 8 }, meteo_max: null, dernier_deplacement: null, ...extra });
  const { pieces, retirees } = migrerPieces([ancien('uav-arme', 'UAV armé 3', { poste: 'id-PC', detruit: true }), ancien('poste-commandement', 'Poste de commandement 1'),
    ancien('blinde', 'Véhicule blindé 1'), ancien('guerre-electronique', 'Guerre électronique 2'), ancien('uav-reco', 'Mon drone'), faire('fantassin', 'f', 'rouge', O)], catalogue);
  assert.deepEqual(retirees, ['Véhicule blindé 1']);
  const par = Object.fromEntries(pieces.map((p) => [p.id, p]));
  assert.equal(par['id-UAV armé 3'].type, 'drone-owa'); assert.equal(par['id-UAV armé 3'].nom, "Drone d'attaque (OWA) 3"); assert.equal(par['id-UAV armé 3'].poste, 'id-PC'); assert.equal(par['id-UAV armé 3'].detruit, true);
  assert.equal(par['id-UAV armé 3'].feu.zone_m2, 25);
  assert.equal(par['id-Poste de commandement 1'].type, 'equipe-pilotes'); assert.equal(par['id-Guerre électronique 2'].nom, 'Brouilleur 2');
  assert.equal(par['id-Mon drone'].nom, 'Mon drone', 'un nom choisi par l\'utilisateur est gardé');
  assert.equal(par.f.camp, 'rouge'); assert.equal(pieces.length, 5);
  assert.deepEqual(migrerPieces(pieces, catalogue).pieces, pieces, 'une seconde migration ne change rien');
});

test('noms : un ancien « PC bleu » devient « Équipe de pilotes bleu », qu\'il vienne de l\'ancien ou du nouveau catalogue', () => {
  const neuf = faire('equipe-pilotes', 'e', 'bleu', O, { nom: 'PC bleu' });
  const ancien = { id: 'o', type: 'poste-commandement', nom: 'PC rouge', camp: 'rouge', lng: 1, lat: 2, mouvement: { min: 1, max: 2 }, feu: { portee_km: 0 }, vision: { rayon_km: 1 } };
  assert.deepEqual(migrerPieces([neuf, ancien], catalogue).pieces.map((p) => p.nom), ['Équipe de pilotes bleu', 'Équipe de pilotes rouge']);
});

test('assistant : le nom donné à une pièce posée est ignoré, la numérotation du catalogue s\'applique', async () => {
  const { planifier } = await import('../static/ia-actions.js');
  const plan = planifier([{ action: 'poser', modele: 'equipe-pilotes', camp: 'bleu', lng: 1, lat: 1, nom: 'PC bleu' }], { pieces: [], catalogue });
  assert.equal(plan[0].op.specs[0].nom, 'Équipe de pilotes 1');
});

test('scénario : chaque modèle du catalogue survit tel quel à l\'enregistrement puis à l\'ouverture', () => {
  for (const m of catalogue) {
    const p = pieceDepuisModele(m, { id: 'p', nom: m.nom, camp: 'rouge', lng: 1, lat: 2 });
    const r = valider(JSON.parse(JSON.stringify(assembler({ pieces: [p], dessins: [], ordres: {}, journal: [] }))));
    assert.equal(r.ok, true, `${m.id} : ${r.erreur}`);
    assert.deepEqual(r.scenario.pieces[0], p, m.id);
  }
});

test('scénario : l\'état de vol, la destruction et la consigne rentrer survivent', () => {
  const d = { ...pieceDepuisModele(modele('drone-isr'), { id: 'd', nom: 'D', camp: 'bleu', lng: 1, lat: 2 }), etat: 'vol', endurance_restante_min: 12.5, detruit: true, cause_destruction: 'endurance', poste: 'e' };
  const r = valider(JSON.parse(JSON.stringify(assembler({ pieces: [d], dessins: [], ordres: { d: [{ id: 'c', type: 'rentrer', statut: 'lance', auto: true }] }, journal: [] }))));
  assert.equal(r.ok, true, r.erreur);
  assert.deepEqual(r.scenario.pieces[0], d); assert.equal(r.scenario.ordres.d[0].auto, true);
  assert.equal(valider(JSON.parse(JSON.stringify(assembler({ pieces: [{ ...d, etat: 'envol' }], dessins: [], ordres: {}, journal: [] })))).ok, false);
});
