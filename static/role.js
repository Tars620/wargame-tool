// Rôle de cet onglet : 'local' (hors partie : tout est permis, comme avant), 'arbitre' (fait tourner la simulation, publie l'état, traite les ordres)
// ou 'joueur' (voit la vue de son camp, donne des ordres que l'arbitre exécute). Module sans dépendance : tous les autres le lisent.
export const role = { genre: 'local', code: null, camp: null, jeton: null, nom: null };
export const definir = (r) => Object.assign(role, r);
export const estJoueur = () => role.genre === 'joueur';
export const estArbitre = () => role.genre !== 'joueur';
export const enPartie = () => role.code !== null;
