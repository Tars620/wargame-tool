// Briques d'interface partagées : fabrique d'éléments, stockage du navigateur, menu déroulant.

export const $ = (id) => document.getElementById(id);

/** Fabrique un élément : h('button', { class: 'x', onclick: f }, 'texte', enfant). Les enfants null ou false sont ignorés. */
export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

// Stockage : jamais d'exception (navigation privée, stockage plein ou bloqué) ; une lecture ratée rend la valeur de repli.
export const lireJson = (cle, repli, stockage = localStorage) => {
  try {
    return JSON.parse(stockage.getItem(cle)) ?? repli;
  } catch {
    return repli;
  }
};
export const ecrireJson = (cle, valeur, stockage = localStorage) => {
  try {
    stockage.setItem(cle, JSON.stringify(valeur));
    return true;
  } catch {
    return false;
  }
};
export const lireTexte = (cle, repli = null, stockage = localStorage) => {
  try {
    return stockage.getItem(cle) ?? repli;
  } catch {
    return repli;
  }
};
export const ecrireTexte = (cle, valeur, stockage = localStorage) => {
  try {
    stockage.setItem(cle, String(valeur));
    return true;
  } catch {
    return false;
  }
};

/**
 * Comportement commun des boutons qui déroulent un menu : ouverture, fermeture par clic ailleurs et Échap.
 * `boite` contient le bouton et le menu. Rend `ouvrir(bool)` ; `surOuverture` est appelée à chaque ouverture.
 */
export function menuDeroulant(boite, principal, menu, surOuverture = () => {}) {
  const ouvrir = (ouvert) => {
    menu.hidden = !ouvert;
    principal.setAttribute('aria-expanded', String(ouvert));
    if (ouvert) surOuverture();
  };
  principal.addEventListener('click', () => ouvrir(menu.hidden));
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !boite.contains(e.target)) ouvrir(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      ouvrir(false);
      principal.focus();
    }
  });
  return ouvrir;
}

/**
 * Mise à jour d'une source GeoJSON de la carte, sans gaspillage : plusieurs demandes dans la même image n'en font qu'une, et les mêmes données ne sont pas renvoyées
 * (chaque `setData` coûte un recalcul des tuiles dans un autre fil). `getMap` rend la carte, `fabriquer` les données. Rend la fonction à appeler à chaque changement.
 */
export function sourceGeojson(getMap, id, fabriquer) {
  let derniere = null;
  let attente = false;
  const appliquer = () => {
    attente = false;
    const map = getMap();
    const source = map && map.getSource(id);
    if (!source) return;
    const donnees = fabriquer();
    const cle = JSON.stringify(donnees);
    if (cle === derniere) return;
    derniere = cle;
    source.setData(donnees);
  };
  return () => {
    if (attente) return;
    attente = true;
    requestAnimationFrame(appliquer);
  };
}
