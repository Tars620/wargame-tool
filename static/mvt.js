// Décodeur minimal de tuiles vectorielles Mapbox (MVT) : fonctions pures, testables avec node.
// decoder(octets, z, x, y) -> { couche: [{ type: 1|2|3, props, geom }] } ; geom = anneaux/lignes en coordonnées de tuile (0..extent).

function lire(buf) {
  let i = 0;
  const varint = () => {
    let r = 0,
      s = 0,
      b;
    do {
      b = buf[i++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  };
  return {
    varint,
    fini: () => i >= buf.length,
    pos: () => i,
    va: (p) => {
      i = p;
    },
    octets: (n) => {
      const o = buf.subarray(i, i + n);
      i += n;
      return o;
    }
  };
}

function lireValeur(buf) {
  const r = lire(buf);
  let v = null;
  while (!r.fini()) {
    const cle = r.varint(),
      champ = cle >> 3,
      type = cle & 7;
    if (type === 2) {
      const n = r.varint();
      const o = r.octets(n);
      if (champ === 1) v = new TextDecoder().decode(o);
    } else if (type === 0) {
      const n = r.varint();
      if (champ === 4 || champ === 5) v = n;
      else if (champ === 6) v = n % 2 ? -(n + 1) / 2 : n / 2;
      else if (champ === 7) v = Boolean(n);
    } else if (type === 1) {
      const o = r.octets(8);
      if (champ === 3) v = new DataView(o.buffer, o.byteOffset, 8).getFloat64(0, true);
    } else if (type === 5) {
      const o = r.octets(4);
      if (champ === 2) v = new DataView(o.buffer, o.byteOffset, 4).getFloat32(0, true);
    }
  }
  return v;
}

function lireGeometrie(buf) {
  const r = lire(buf);
  const formes = [];
  let courant = null,
    x = 0,
    y = 0;
  const zz = (n) => (n >> 1) ^ -(n & 1);
  while (!r.fini()) {
    const cmd = r.varint(),
      id = cmd & 7,
      n = cmd >> 3;
    for (let k = 0; k < n; k += 1) {
      if (id === 7) {
        if (courant) courant.fermee = true;
        continue;
      }
      x += zz(r.varint());
      y += zz(r.varint());
      if (id === 1) {
        courant = { pts: [[x, y]] };
        formes.push(courant);
      } else if (courant) courant.pts.push([x, y]);
    }
  }
  return formes;
}

function lireCouche(buf) {
  const r = lire(buf);
  const couche = { nom: '', extent: 4096, cles: [], valeurs: [], faces: [] };
  while (!r.fini()) {
    const cle = r.varint(),
      champ = cle >> 3,
      type = cle & 7;
    if (type === 2) {
      const n = r.varint();
      const o = r.octets(n);
      if (champ === 1) couche.nom = new TextDecoder().decode(o);
      else if (champ === 2) couche.faces.push(o);
      else if (champ === 3) couche.cles.push(new TextDecoder().decode(o));
      else if (champ === 4) couche.valeurs.push(lireValeur(o));
    } else if (type === 0) {
      const n = r.varint();
      if (champ === 5) couche.extent = n;
    } else if (type === 1) r.octets(8);
    else if (type === 5) r.octets(4);
  }
  return couche;
}

function lireFace(buf, couche) {
  const r = lire(buf);
  const f = { type: 0, props: {}, geom: [] };
  while (!r.fini()) {
    const cle = r.varint(),
      champ = cle >> 3,
      type = cle & 7;
    if (type === 0) {
      const n = r.varint();
      if (champ === 3) f.type = n;
    } else if (type === 2) {
      const n = r.varint();
      const o = r.octets(n);
      if (champ === 2) {
        const t = lire(o);
        const idx = [];
        while (!t.fini()) idx.push(t.varint());
        for (let i = 0; i + 1 < idx.length; i += 2) f.props[couche.cles[idx[i]]] = couche.valeurs[idx[i + 1]];
      } else if (champ === 4) f.geom = lireGeometrie(o);
    } else if (type === 1) r.octets(8);
    else if (type === 5) r.octets(4);
  }
  return f;
}

/** Décode une tuile : { couche: { extent, faces: [{ type, props, geom }] } }. `octets` : Uint8Array déjà décompressé. */
export function decoder(octets) {
  const r = lire(octets);
  const out = {};
  while (!r.fini()) {
    const cle = r.varint(),
      champ = cle >> 3,
      type = cle & 7;
    if (type === 2) {
      const n = r.varint();
      const o = r.octets(n);
      if (champ === 3) {
        const c = lireCouche(o);
        out[c.nom] = { extent: c.extent, faces: c.faces.map((fb) => lireFace(fb, c)) };
      }
    } else if (type === 0) r.varint();
    else if (type === 1) r.octets(8);
    else if (type === 5) r.octets(4);
  }
  return out;
}
