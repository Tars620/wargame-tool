// État partagé des pièces : catalogue, pièces, sélection, marqueurs. Un seul objet, jamais modifié en place (voir maj).
import { estJoueur } from './role.js';
import { ecrireJson, lireJson } from './ui.js';

export const SOURCE_ID = 'portees';
export const STORAGE_KEY = 'wg.pieces.v1';
export const COULEURS = { bleu: '#4c8dff', rouge: '#e5484d' };
export const NOM_CAMP = { bleu: 'Bleu', rouge: 'Rouge' };
export const state = {
  retirees: [],
  catalogue: [],
  pieces: [],
  camp: 'bleu',
  arme: null,
  selection: null,
  portees: 'selection',
  map: null,
  marqueurs: new Map(),
  racine: null,
  visibles: null,
  // Liens entre modules, fixés par les modules qui les possèdent (évite les imports circulaires) :
  surChoix: () => {},
  surDeplacement: () => {},
  redessiner: { fiche: () => {}, banque: () => {} }
};

export function nombre(valeur, min, max, repli) {
  const n = Number(String(valeur).replace(',', '.'));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : repli;
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const piece = (id) => state.pieces.find((p) => p.id === id) || null;

// ---------- persistance (navigateur) ----------
export function sauver() {
  if (!estJoueur()) ecrireJson(STORAGE_KEY, state.pieces);
}
export function charger() {
  const brut = lireJson(STORAGE_KEY, []);
  return Array.isArray(brut) ? brut : [];
}

// ---------- état : jamais de modification en place ----------
export function maj(id, patch) {
  state.pieces = state.pieces.map((p) => (p.id === id ? { ...p, ...patch } : p));
  sauver();
}

export const estVisible = (p) => !state.visibles || state.visibles.has(p.id);
export function signaler() {
  document.dispatchEvent(new CustomEvent('wg:pieces'));
}
