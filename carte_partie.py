"""Carte partagée d'une partie : état publié par l'arbitre, vues filtrées par rôle, ordres des joueurs.

Principe : l'arbitre fait tourner la simulation dans son navigateur et publie l'état ici. Chaque participant reçoit SA vue :
l'arbitre voit tout ; un joueur voit ses pièces, ses ordres, ses tracés, et les pièces adverses que l'arbitre déclare détectées par son camp.
Le filtrage se fait ICI, côté serveur : une donnée adverse non détectée ne quitte jamais cette machine.
"""
import json
import re
import sqlite3

from server_commun import ApiError, clean_text, now_iso

MAX_ETAT = 2 * 1024 * 1024      # taille maximale d'un état publié
MAX_PIECES = 500
MAX_COMMANDES_ATTENTE = 100     # par camp
MAX_EVENEMENTS_LOT = 50
TYPES_CONSIGNE = ("aller", "observer", "engager", "rentrer")
ALLURES = ("prudente", "normale", "maximale")
GENRES_EVENEMENT = ("info", "tir", "alerte", "contact", "op")
# Ce que voit un joueur d'une pièce adverse détectée : identité et position, rien de son état interne (équipe, endurance, vol, cause de destruction).
CHAMPS_ADVERSE = ("id", "type", "icone", "categorie", "nom", "camp", "lng", "lat", "detruit")

SCHEMA = """
CREATE TABLE IF NOT EXISTS carte_etat (code TEXT PRIMARY KEY, rev INTEGER NOT NULL, maj TEXT NOT NULL, etat TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS carte_commandes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, side TEXT NOT NULL, auteur TEXT NOT NULL, ts TEXT NOT NULL,
  corps TEXT NOT NULL, statut TEXT NOT NULL, reponse TEXT NOT NULL DEFAULT '');
"""


# ---------- fonctions pures ----------
def _liste(x, maxi=MAX_PIECES):
    return [e for e in x[:maxi] if isinstance(e, dict)] if isinstance(x, list) else []


def etat_nettoye(brut):
    """État publié par l'arbitre, réduit aux champs connus et vérifié (forme et tailles)."""
    if not isinstance(brut, dict):
        raise ApiError(400, "État invalide")
    pieces = _liste(brut.get("pieces"))
    if any(not isinstance(p.get("id"), str) or p.get("camp") not in ("bleu", "rouge") for p in pieces):
        raise ApiError(400, "Chaque pièce doit avoir un identifiant et un camp (bleu ou rouge)")
    ordres = brut.get("ordres") if isinstance(brut.get("ordres"), dict) else {}
    visibles = brut.get("visibles") if isinstance(brut.get("visibles"), dict) else {}
    horloge = brut.get("horloge") if isinstance(brut.get("horloge"), dict) else None
    return {
        "pieces": pieces,
        "ordres": {str(k): v for k, v in ordres.items() if isinstance(v, list)},
        "dessins": _liste(brut.get("dessins"), 2000),
        "coupures": _liste(brut.get("coupures"), 500),
        "impacts": _liste(brut.get("impacts"), 100),
        "horloge": {k: horloge[k] for k in ("ms", "vitesse", "enMarche") if k in horloge} if horloge else None,
        "visibles": {c: [i for i in visibles.get(c, []) if isinstance(i, str)] for c in ("bleu", "rouge") if isinstance(visibles.get(c), list)},
    }


def vue_pour(etat, kind, side):
    """La vue d'un participant. L'arbitre reçoit tout (sauf rien) ; un joueur : ses pièces, les adverses détectées, ses ordres, ses tracés."""
    if kind == "adjudicator":
        return {"horloge": etat.get("horloge"), "pieces": etat.get("pieces", []), "ordres": etat.get("ordres", {}),
                "dessins": etat.get("dessins", []), "coupures": etat.get("coupures", []), "impacts": etat.get("impacts", []), "visibles": etat.get("visibles", {})}
    pieces = etat.get("pieces", [])
    detectees = set((etat.get("visibles") or {}).get(side) or [])
    propres = [p for p in pieces if p.get("camp") == side]
    adverses = [{k: p[k] for k in CHAMPS_ADVERSE if k in p} for p in pieces if p.get("camp") != side and p.get("id") in detectees]
    ids = {p["id"] for p in propres}
    return {"horloge": etat.get("horloge"), "pieces": propres + adverses,
            "ordres": {pid: file for pid, file in (etat.get("ordres") or {}).items() if pid in ids},
            "dessins": [d for d in etat.get("dessins", []) if d.get("camp") in (side, "neutre")],
            "coupures": etat.get("coupures", []), "impacts": etat.get("impacts", [])}  # un cratère sur une route se voit des deux camps


def _nombre(x, mini, maxi):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and mini <= x <= maxi


def _id(x):
    return isinstance(x, str) and 0 < len(x) <= 40


def commande_valide(corps, etat, side):
    """Vérifie et normalise l'ordre d'un joueur. Rend le corps retenu ; lève ApiError sinon."""
    if not isinstance(corps, dict) or corps.get("type") not in ("consigne", "annuler"):
        raise ApiError(400, "Ordre inconnu")
    pid = corps.get("pieceId")
    piece = next((p for p in etat.get("pieces", []) if p.get("id") == pid), None) if _id(pid) else None
    if not piece or piece.get("camp") != side:
        raise ApiError(403, "Vous ne pouvez commander que les pièces de votre camp")
    if piece.get("detruit"):
        raise ApiError(409, "Cette pièce est détruite")
    if corps["type"] == "annuler":
        if not _id(corps.get("consigneId")):
            raise ApiError(400, "Consigne à annuler invalide")
        return {"type": "annuler", "pieceId": pid, "consigneId": corps["consigneId"]}
    c = corps.get("consigne")
    if not isinstance(c, dict) or c.get("type") not in TYPES_CONSIGNE:
        raise ApiError(400, "Consigne invalide")
    sortie = {"type": c["type"]}
    if c.get("allure") is not None:
        if c["allure"] not in ALLURES:
            raise ApiError(400, "Allure inconnue")
        sortie["allure"] = c["allure"]
    if c["type"] == "aller":
        pts = c.get("points")
        if not isinstance(pts, list) or not 1 <= len(pts) <= 50 or any(
                not isinstance(p, list) or len(p) != 2 or not _nombre(p[0], -360, 360) or not _nombre(p[1], -90, 90) for p in pts):
            raise ApiError(400, "Destination invalide")
        sortie["points"] = [[p[0], p[1]] for p in pts]
    elif c["type"] == "observer":
        if not _nombre(c.get("dureeMin"), 0, 10000):
            raise ApiError(400, "Durée invalide")
        sortie["dureeMin"] = c["dureeMin"]
    elif c["type"] == "engager":
        cible = c.get("cibleId")
        if not _id(cible):
            raise ApiError(400, "Cible invalide")
        if cible not in ((etat.get("visibles") or {}).get(side) or []) and not any(p.get("id") == cible and p.get("camp") == side for p in etat.get("pieces", [])):
            raise ApiError(403, "Cette cible n'est pas détectée par votre camp")
        sortie["cibleId"] = cible
    return {"type": "consigne", "pieceId": pid, "consigne": sortie}


# ---------- stockage ----------
class CartePartie:
    """Accès base de la carte partagée ; s'appuie sur le Store du journal (parties, rôles, chaîne d'événements)."""

    def __init__(self, store):
        self.s = store
        with store.lock:
            store.conn.executescript(SCHEMA)

    def _membre(self, code, token, kinds):
        g = self.s._game(code)
        m = self.s._member(g["code"], token)
        if m["kind"] not in kinds:
            raise ApiError(403, "Ce rôle n'a pas accès à cette fonction")
        if g["status"] != "running":
            raise ApiError(409, "La partie est terminée")
        return g, m

    def _etat(self, code):
        row = self.s.conn.execute("SELECT rev, etat FROM carte_etat WHERE code=?", (code,)).fetchone()
        return (row["rev"], json.loads(row["etat"])) if row else (0, None)

    def publier(self, code, token, corps):
        with self.s.lock:
            g, _ = self._membre(code, token, ("adjudicator",))
            etat = etat_nettoye(corps.get("etat"))
            brut = json.dumps(etat, ensure_ascii=False, separators=(",", ":"))
            if len(brut) > MAX_ETAT:
                raise ApiError(413, "État trop volumineux")
            rev = self._etat(g["code"])[0] + 1
            self.s.conn.execute("INSERT INTO carte_etat VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET rev=excluded.rev, maj=excluded.maj, etat=excluded.etat",
                                (g["code"], rev, now_iso(), brut))
            self.s.conn.commit()
        return {"rev": rev}

    def etat_complet(self, code, token):
        with self.s.lock:
            g, _ = self._membre(code, token, ("adjudicator",))
            rev, etat = self._etat(g["code"])
        return {"rev": rev, "etat": etat}

    def vue(self, code, token, apres=0):
        with self.s.lock:
            g, m = self._membre(code, token, ("adjudicator", "player"))
            rev, etat = self._etat(g["code"])
            if etat is None:
                return {"rev": 0, "vide": True, "role": {"kind": m["kind"], "side": m["side"]}}
            commandes = []
            if m["kind"] == "player":
                rows = self.s.conn.execute("SELECT id, ts, corps, statut, reponse FROM carte_commandes WHERE code=? AND side=? ORDER BY id DESC LIMIT 20",
                                           (g["code"], m["side"])).fetchall()
                commandes = [{"id": r["id"], "ts": r["ts"], "corps": json.loads(r["corps"]), "statut": r["statut"], "reponse": r["reponse"]} for r in rows]
        reponse = {"rev": rev, "role": {"kind": m["kind"], "side": m["side"]}, "commandes": commandes}
        if apres == rev:
            return {**reponse, "inchange": True}  # les ordres du joueur et leur résultat sont déjà dans `reponse`
        return {**reponse, **vue_pour(etat, m["kind"], m["side"])}

    def commander(self, code, token, corps):
        with self.s.lock:
            g, m = self._membre(code, token, ("player",))
            rev, etat = self._etat(g["code"])
            if etat is None:
                raise ApiError(409, "La partie n'a pas encore commencé")
            ordre = commande_valide(corps, etat, m["side"])
            en_attente = self.s.conn.execute("SELECT COUNT(*) FROM carte_commandes WHERE code=? AND side=? AND statut='attente'", (g["code"], m["side"])).fetchone()[0]
            if en_attente >= MAX_COMMANDES_ATTENTE:
                raise ApiError(429, "Trop d'ordres en attente : l'arbitre doit les traiter")
            cur = self.s.conn.execute("INSERT INTO carte_commandes (code, side, auteur, ts, corps, statut) VALUES (?,?,?,?,?, 'attente')",
                                      (g["code"], m["side"], m["name"], now_iso(), json.dumps(ordre, ensure_ascii=False)))
            self.s._append(g["code"], m, "carte_order", [m["side"]], {"commande": cur.lastrowid, "ordre": ordre})
            self.s.conn.commit()
        return {"id": cur.lastrowid, "statut": "attente"}

    def commandes_en_attente(self, code, token):
        with self.s.lock:
            g, _ = self._membre(code, token, ("adjudicator",))
            rows = self.s.conn.execute("SELECT id, side, auteur, ts, corps FROM carte_commandes WHERE code=? AND statut='attente' ORDER BY id LIMIT 100", (g["code"],)).fetchall()
        return {"commandes": [{"id": r["id"], "side": r["side"], "auteur": r["auteur"], "ts": r["ts"], "corps": json.loads(r["corps"])} for r in rows]}

    def resultat_commande(self, code, token, cid, corps):
        ok = corps.get("ok") is True
        message = clean_text(corps.get("message"), "message", False, 300)
        with self.s.lock:
            g, _ = self._membre(code, token, ("adjudicator",))
            cur = self.s.conn.execute("UPDATE carte_commandes SET statut=?, reponse=? WHERE id=? AND code=? AND statut='attente'",
                                      ("traitee" if ok else "refusee", message, cid, g["code"]))
            if cur.rowcount == 0:
                raise ApiError(404, "Ordre introuvable ou déjà traité")
            self.s.conn.commit()
        return {"id": cid, "statut": "traitee" if ok else "refusee"}

    def evenements(self, code, token, corps):
        """Événements de la simulation, enregistrés dans la chaîne avec leur public (camps concernés, tous, ou arbitrage seul)."""
        lot = corps.get("evenements")
        if not isinstance(lot, list) or not 1 <= len(lot) <= MAX_EVENEMENTS_LOT:
            raise ApiError(400, f"Un lot compte de 1 à {MAX_EVENEMENTS_LOT} événements")
        with self.s.lock:
            g, m = self._membre(code, token, ("adjudicator",))
            for e in lot:
                if not isinstance(e, dict):
                    raise ApiError(400, "Événement invalide")
                texte = clean_text(e.get("texte"), "texte", True, 400)
                genre = e.get("genre") if e.get("genre") in GENRES_EVENEMENT else "info"
                t = e.get("t") if _nombre(e.get("t"), 0, 4e15) else 0
                public = e.get("visible_to")
                if public == "all":
                    vt = "all"
                elif isinstance(public, list) and all(s in g["sides"] for s in public):
                    vt = public if public else ["staff"]
                else:
                    raise ApiError(400, "Public de l'événement invalide")
                self.s._append(g["code"], m, "carte_event", vt, {"texte": texte, "genre": genre, "t": t})
            self.s.conn.commit()
        return {"enregistres": len(lot)}

