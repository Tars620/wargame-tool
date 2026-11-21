// Récupère une tuile de la planète en ligne via le serveur local et la décode : node tools/tuile.mjs LNG LAT [Z]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decoder } from '../static/mvt.js';
const ctx = { self: {}, Headers, AbortController, AbortSignal, DecompressionStream, console, TextDecoder, TextEncoder, Promise, Response, fetch, DataView, Uint8Array, ArrayBuffer, Math, Object, Symbol, Error, Map, Set, Date, JSON };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../static/vendor/pmtiles.js', import.meta.url), 'utf8'), ctx);
const { PMTiles, FetchSource } = ctx.pmtiles;
const [lng, lat, z = 14] = process.argv.slice(2).map(Number);
const n = 2 ** z, x = Math.floor(((lng + 180) / 360) * n), y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
const p = new PMTiles('http://localhost:8080/enligne/planete-en-ligne');
const t = await p.getZxy(z, x, y);
console.log('tuile', z, x, y, t ? t.data.byteLength : 'vide');
if (process.argv[5]) (await import('node:fs')).writeFileSync(process.argv[5], new Uint8Array(t.data));
const d = decoder(new Uint8Array(t.data));
for (const [nom, c] of Object.entries(d)) {
  const kinds = {};
  for (const f of c.faces) { const k = `${f.type}:${f.props.kind || ''}${f.props.kind_detail ? '/' + f.props.kind_detail : ''}`; kinds[k] = (kinds[k] || 0) + 1; }
  console.log(nom, c.extent, c.faces.length, JSON.stringify(kinds));
}
