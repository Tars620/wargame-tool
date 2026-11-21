// État partagé du module des ordres : consignes par pièce, journal, point de vue, pointage. Un seul objet, modifié par journal, simulation, carte et panneau.
import { formatKm } from './geo.js';
import { ALLURES } from './moteur.js';
import { listerPieces, pieceChoisie } from './pieces.js';
import { estJoueur } from './role.js';
import { ecrireJson } from './ui.js';

export const SOURCE_CONSIGNES = 'consignes';
export const STORAGE_ORDRES = 'wg.ordres.v1';
export const STORAGE_JOURNAL = 'wg.journal.v1';

export const state = { map: null, ordres: {}, journal: [], depart: null, pointDeVue: 'arbitre', pointage: null,
  forme: { type: 'aller', allure: 'normale', dureeMin: 10, cibleId: '' }, contactsVus: new Set(), liaisons: null, positionsEquipes: new Map(), meteo: null, theme: 'sombre',
  redessinerListe: () => {} }; // fixé par le panneau : la simulation lui demande de rafraîchir la liste des consignes

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const sauver = () => { if (estJoueur()) return; ecrireJson(STORAGE_ORDRES, state.ordres); ecrireJson(STORAGE_JOURNAL, state.journal); };
export const nomDe = (pieces, id) => (pieces.find((p) => p.id === id) || { nom: 'pièce retirée' }).nom;
export const km = (x) => formatKm(x);
/** Camps (bleu, rouge) des pièces désignées : le public naturel d'un événement qui les concerne. */
export const cotes = (pieces, ...ids) => [...new Set(ids.map((id) => (pieces.find((p) => p.id === id) || {}).camp).filter(Boolean))];

export const pieceCourante = () => listerPieces().find((p) => p.id === pieceChoisie()) || null;
export const fileDe = (id) => state.ordres[id] || [];
export function majFile(id, fn) { state.ordres = { ...state.ordres, [id]: fn(fileDe(id)) }; sauver(); }

export function libelle(c, pieces) {
  if (c.type === 'aller') return `Aller à ${c.points.length > 1 ? `${c.points.length} points` : 'un point'} (${km(c.distanceKm || 0)}, allure ${ALLURES[c.allure].toLowerCase()})`;
  if (c.type === 'observer') return `Observer ${c.dureeMin} min`;
  if (c.type === 'rentrer') return c.auto ? 'Rentrer se poser (retour automatique)' : 'Rentrer se poser';
  return `Engager ${nomDe(pieces, c.cibleId)}`;
}

