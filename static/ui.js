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
export const lireJson = (cle, repli, stockage = localStorage) => { try { return JSON.parse(stockage.getItem(cle)) ?? repli; } catch { return repli; } };
export const ecrireJson = (cle, valeur, stockage = localStorage) => { try { stockage.setItem(cle, JSON.stringify(valeur)); return true; } catch { return false; } };
export const lireTexte = (cle, repli = null, stockage = localStorage) => { try { return stockage.getItem(cle) ?? repli; } catch { return repli; } };
export const ecrireTexte = (cle, valeur, stockage = localStorage) => { try { stockage.setItem(cle, String(valeur)); return true; } catch { return false; } };

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
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !boite.contains(e.target)) ouvrir(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { ouvrir(false); principal.focus(); } });
  return ouvrir;
}
