// Heures et fuseaux : fonctions pures (testables avec node). Toutes les heures de jeu sont des millisecondes UTC.
export const PARIS = 'Europe/Paris';

const formateurs = new Map();
function formateur(zone, options) {
  const cle = zone + JSON.stringify(options);
  if (!formateurs.has(cle)) formateurs.set(cle, new Intl.DateTimeFormat('fr-FR', { timeZone: zone, hourCycle: 'h23', ...options }));
  return formateurs.get(cle);
}

/** Décalage de `zone` par rapport à UTC à l'instant `ms`, en minutes (Paris : 60 l'hiver, 120 l'été). */
export function decalageMin(ms, zone) {
  const p = Object.fromEntries(
    formateur(zone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, Number(x.value)])
  );
  const vu = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((vu - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Heure lisible « 14:32:05 » dans `zone`. */
export function heure(ms, zone) {
  return formateur(zone, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
}

/** Date lisible « sam. 21/11 » dans `zone`. */
export function date(ms, zone) {
  return formateur(zone, { weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(ms));
}

/** « UTC+1 », « UTC+5:30 ». */
export function etiquetteDecalage(ms, zone) {
  const m = decalageMin(ms, zone);
  const signe = m < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(m) / 60);
  const reste = Math.abs(m) % 60;
  return `UTC${signe}${h}${reste ? `:${String(reste).padStart(2, '0')}` : ''}`;
}

/** Nom court du lieu d'un fuseau : « Europe/Budapest » → « Budapest » ; les fuseaux de pleine mer n'ont pas de nom. */
export function nomZone(zone) {
  if (!zone || zone.startsWith('Etc/')) return 'En mer';
  return zone.split('/').pop().replaceAll('_', ' ');
}

/** Écart d'heures entre une zone et Paris à l'instant `ms` (ex. 1, -6, 5.5). */
export function ecartAvecParis(ms, zone) {
  return (decalageMin(ms, zone) - decalageMin(ms, PARIS)) / 60;
}

/** Convertit « 2026-11-21T14:00 » saisi en heure de Paris en millisecondes UTC. */
export function parisVersMs(saisie) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(saisie || '');
  if (!m) return null;
  const naif = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const premier = naif - decalageMin(naif, PARIS) * 60000;
  return naif - decalageMin(premier, PARIS) * 60000; // second passage : sûr autour des changements d'heure
}

/** « 2026-11-21T14:00 » : l'instant `ms` exprimé en heure de Paris (pour un champ datetime-local). */
export function msVersParis(ms) {
  const p = Object.fromEntries(
    formateur(PARIS, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
