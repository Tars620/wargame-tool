// Audit de la mise en page, à coller dans la console d'une page /carte (ou à passer à agent-browser eval) : mesure au lieu de supposer.
// Rend la liste des défauts : cellules mal alignées, panneaux qui ne touchent pas les bords, recouvrements, textes coupés, débordements.
(() => {
  const W = innerWidth, H = innerHeight, defauts = [];
  const rect = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const visible = (e) => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
  const nom = (e) => (e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : ''}`) + (e.textContent ? ` « ${e.textContent.trim().slice(0, 20)} »` : '');
  const q = (s) => [...document.querySelectorAll(s)].filter(visible);

  // 1. cellules alignées : même haut et même hauteur dans chaque barre
  for (const [barre, enfants] of [['barre du haut', '.top > *'], ['barre d\'outils', '.outils > *'], ['commandes du temps', '.temps-cmd > *'], ['thème', '.seg > *'], ['onglets', '.onglets > *']]) {
    const cs = q(enfants).map(rect);
    if (cs.length > 1 && (Math.max(...cs.map((c) => c.y)) - Math.min(...cs.map((c) => c.y)) > 1.5 || Math.max(...cs.map((c) => c.h)) - Math.min(...cs.map((c) => c.h)) > 1.5)) {
      if (barre !== 'barre du haut') defauts.push(`${barre} : cellules de hauteurs ou de hauts différents`);
    }
  }
  // 2. la barre du haut : tout est centré verticalement sur son milieu
  const top = document.querySelector('.top'); const milieu = rect(top).y + rect(top).h / 2;
  for (const e of q('.top > *')) { const b = rect(e); if (Math.abs(b.y + b.h / 2 - milieu) > 2) defauts.push(`barre du haut : ${nom(e)} décentré de ${(b.y + b.h / 2 - milieu).toFixed(1)} px`); }
  // 3. panneaux et carte : collés aux bords, sans trou ni recouvrement
  const g = document.querySelector('.panneau.gauche'), d = document.querySelector('.panneau.droite'), carte = document.getElementById('map'), outils = document.querySelector('.barre-outils');
  const hautVu = outils && visible(outils) ? rect(outils).b : rect(top).b;
  const cb = rect(carte), gb = rect(g), db = rect(d);
  const gOuvert = gb.r > 1, dOuvert = db.x < W - 1;
  if (Math.abs(cb.y - hautVu) > 1) defauts.push(`carte : son haut (${cb.y.toFixed(0)}) n'est pas sous la barre (${hautVu.toFixed(0)})`);
  if (Math.abs(cb.b - H) > 1) defauts.push(`carte : son bas (${cb.b.toFixed(0)}) n'atteint pas le bas de l'écran (${H})`);
  if (gOuvert && Math.abs(gb.x) > 1) defauts.push('panneau de gauche : ne touche pas le bord gauche');
  if (dOuvert && Math.abs(db.r - W) > 1) defauts.push('panneau de droite : ne touche pas le bord droit');
  if (Math.abs(cb.x - (gOuvert ? gb.r : 0)) > 1.5) defauts.push(`carte : sa gauche (${cb.x.toFixed(0)}) ne touche pas le panneau (${gOuvert ? gb.r.toFixed(0) : 0})`);
  if (Math.abs(cb.r - (dOuvert ? db.x : W)) > 1.5) defauts.push(`carte : sa droite (${cb.r.toFixed(0)}) ne touche pas le panneau (${dOuvert ? db.x.toFixed(0) : W})`);
  for (const p of [g, d]) { const b = rect(p); if (Math.abs(b.y - hautVu) > 1) defauts.push(`${nom(p)} : son haut (${b.y.toFixed(0)}) n'est pas sous la barre (${hautVu.toFixed(0)})`); }
  // 4. rien ne dépasse de l'écran
  for (const e of q('body *')) { if (e.closest('.maplibregl-map') || e.closest('.maplibregl-canvas-container')) continue; const b = rect(e); if (b.r > W + 1 || b.b > H + 1 || b.x < -1) { if (!e.closest('.panneau') || b.x >= -1) defauts.push(`hors écran : ${nom(e)} (${b.x.toFixed(0)}..${b.r.toFixed(0)}, ${b.y.toFixed(0)}..${b.b.toFixed(0)})`); } }
  // 5. recouvrements entre éléments flottants sur la carte
  const flottants = q('.lecture, .maplibregl-ctrl-scale, .maplibregl-ctrl-attrib, .maplibregl-ctrl-bottom-right .maplibregl-ctrl-group, .maplibregl-ctrl-top-left .maplibregl-ctrl, .maplibregl-ctrl-top-right .maplibregl-ctrl, #onglet-g, #onglet-d, .banniere');
  for (let i = 0; i < flottants.length; i += 1) for (let j = i + 1; j < flottants.length; j += 1) {
    const a = rect(flottants[i]), b = rect(flottants[j]);
    if (a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5) defauts.push(`recouvrement : ${nom(flottants[i])} et ${nom(flottants[j])}`);
  }
  // 6. textes coupés
  for (const e of q('button, label, summary, .note, .opt span, option, h4, .champ span, .onglets button, .outils > *')) {
    if (getComputedStyle(e).overflow !== 'visible' && e.scrollWidth > e.clientWidth + 1) defauts.push(`texte coupé : ${nom(e)}`);
  }
  // 7. défilement horizontal parasite dans les panneaux
  for (const p of [g, d]) if (visible(p) && p.scrollWidth > p.clientWidth + 1) defauts.push(`${nom(p)} : défilement horizontal (${p.scrollWidth} > ${p.clientWidth})`);
  return JSON.stringify({ fenetre: `${W}x${H}`, controles: { gauche: gOuvert, droite: dOuvert }, defauts }, null, 1);
})()
