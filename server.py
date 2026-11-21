#!/usr/bin/env python3
"""Journal de partie de wargame : capture, traçabilité, logistique.

Un seul fichier serveur, bibliothèque standard uniquement (réseau fermé : rien à installer).
Les décisions restent humaines : l'outil enregistre, ne décide pas.

  python3 server.py [--host 0.0.0.0] [--port 8080] [--db wargame.db]
"""
import argparse
import hashlib
import json
import os
import re
import secrets
import socket
import sqlite3
import ssl
import threading
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
MAPS_DIR = os.path.join(HERE, "data", "maps")
ZONES_FILE = os.path.join(HERE, "zones.json")
CHUNK = 1024 * 1024
MAX_RELAIS = 8 * 1024 * 1024  # taille maximale d'une tranche relayée depuis une carte en ligne
CERTIFICATS = "/etc/ssl/cert.pem"
RELAIS_CACHE_MAX = 128 * 1024 * 1024  # mémoire gardée pour les tranches déjà relayées
_relais_cache = OrderedDict()
_relais_taille = 0
_relais_verrou = threading.Lock()
GENESIS = "0" * 64
MAX_TEXT = 4000
MAX_BODY = 64 * 1024
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
KINDS = ("player", "adjudicator", "observer")
# Qui peut écrire quoi. Le reste est refusé côté serveur, jamais seulement masqué dans l'écran.
ALLOWED = {
    "player": {"move", "lesson"},
    "adjudicator": {"adjudication", "inject", "turn_start", "game_end", "note", "lesson"},
    "observer": {"note", "lesson"},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
  code TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL, scenario TEXT NOT NULL,
  sides TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, adj_key TEXT NOT NULL, obs_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  token TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  side TEXT, joined TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  code TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
  side TEXT, type TEXT NOT NULL, turn INTEGER NOT NULL, visible_to TEXT NOT NULL, payload TEXT NOT NULL,
  prev TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (code, seq));
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def canon(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def event_hash(ev):
    body = {k: ev[k] for k in ("code", "seq", "ts", "actor", "role", "side", "type", "turn",
                               "visible_to", "payload", "prev")}
    return hashlib.sha256(canon(body).encode("utf-8")).hexdigest()


def clean_text(value, name, required=False, limit=MAX_TEXT):
    text = (value or "").strip() if isinstance(value, str) or value is None else None
    if text is None:
        raise ApiError(400, f"« {name} » doit être du texte")
    if required and not text:
        raise ApiError(400, f"« {name} » est obligatoire")
    if len(text) > limit:
        raise ApiError(400, f"« {name} » dépasse {limit} caractères")
    return text


def row_event(row):
    ev = dict(row)
    ev["visible_to"] = json.loads(ev["visible_to"])
    ev["payload"] = json.loads(ev["payload"])
    return ev


def visible(ev, member, ended):
    """Brouillard de guerre : un joueur ne voit que ce qui est public ou destiné à son camp."""
    if ended or member["kind"] in ("adjudicator", "observer"):
        return True
    vt = ev["visible_to"]
    return vt == "all" or (isinstance(vt, list) and member["side"] in vt)


def redact(ev, member, ended):
    """La justification d'un arbitrage reste à l'équipe d'arbitrage jusqu'à la fin de la partie."""
    if ended or member["kind"] != "player" or ev["type"] != "adjudication":
        return ev
    payload = {k: v for k, v in ev["payload"].items() if k != "rationale"}
    return {**ev, "payload": payload}


class Store:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.executescript(SCHEMA)

    # ---------- parties et participants ----------
    def create_game(self, data):
        title = clean_text(data.get("title"), "titre", True, 200)
        objective = clean_text(data.get("objective"), "objectif", True)
        scenario = clean_text(data.get("scenario"), "scénario")
        creator = clean_text(data.get("name"), "votre nom", True, 80)
        sides = [clean_text(s, "camp", True, 40) for s in (data.get("sides") or []) if str(s).strip()]
        if len(sides) < 2 or len(set(sides)) != len(sides):
            raise ApiError(400, "Il faut au moins deux camps distincts")
        with self.lock:
            code = self._new_code()
            adj_key, obs_key = secrets.token_hex(4), secrets.token_hex(4)
            self.conn.execute("INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?)",
                              (code, title, objective, scenario, json.dumps(sides, ensure_ascii=False),
                               "running", now_iso(), adj_key, obs_key))
            token = self._add_member(code, creator, "adjudicator", None)
            member = self._member(code, token)
            self._append(code, member, "game_created", "all",
                         {"title": title, "objective": objective, "scenario": scenario, "sides": sides}, turn=1)
            self._append(code, member, "turn_start", "all", {"label": "Tour 1"}, turn=1)
            self.conn.commit()
        return {"code": code, "token": token, "adj_key": adj_key, "obs_key": obs_key}

    def _new_code(self):
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(5))
            if not self.conn.execute("SELECT 1 FROM games WHERE code=?", (code,)).fetchone():
                return code

    def _game(self, code):
        row = self.conn.execute("SELECT * FROM games WHERE code=?", ((code or "").upper(),)).fetchone()
        if not row:
            raise ApiError(404, "Partie introuvable")
        game = dict(row)
        game["sides"] = json.loads(game["sides"])
        return game

    def _add_member(self, code, name, kind, side):
        token = secrets.token_urlsafe(24)
        self.conn.execute("INSERT INTO members VALUES (?,?,?,?,?,?)", (token, code, name, kind, side, now_iso()))
        return token

    def _member(self, code, token):
        row = self.conn.execute("SELECT * FROM members WHERE token=? AND code=?",
                                (token or "", code.upper())).fetchone()
        if not row:
            raise ApiError(401, "Session inconnue : rejoignez la partie")
        return dict(row)

    def info(self, code):
        with self.lock:
            g = self._game(code)
        return {"code": g["code"], "title": g["title"], "sides": g["sides"], "status": g["status"]}

    def join(self, code, data):
        name = clean_text(data.get("name"), "nom", True, 80)
        kind = data.get("kind")
        if kind not in KINDS:
            raise ApiError(400, "Rôle inconnu")
        with self.lock:
            g = self._game(code)
            if g["status"] != "running":
                raise ApiError(409, "La partie est terminée")
            side = None
            if kind == "player":
                side = data.get("side")
                if side not in g["sides"]:
                    raise ApiError(400, "Choisissez un camp de la partie")
            else:
                key = (data.get("key") or "").strip()
                expected = g["adj_key"] if kind == "adjudicator" else g["obs_key"]
                if not secrets.compare_digest(key, expected):
                    raise ApiError(403, "Clé incorrecte pour ce rôle")
            token = self._add_member(g["code"], name, kind, side)
            member = self._member(g["code"], token)
            self._append(g["code"], member, "joined", "all", {"name": name, "kind": kind, "side": side})
            self.conn.commit()
        return {"code": g["code"], "token": token}

    # ---------- journal ----------
    def _last(self, code):
        return self.conn.execute("SELECT seq, hash, turn FROM events WHERE code=? ORDER BY seq DESC LIMIT 1",
                                 (code,)).fetchone()

    def _append(self, code, member, etype, visible_to, payload, turn=None):
        last = self._last(code)
        ev = {"code": code, "seq": (last["seq"] + 1) if last else 1, "ts": now_iso(),
              "actor": member["name"], "role": member["kind"], "side": member["side"], "type": etype,
              "turn": turn if turn is not None else (last["turn"] if last else 1),
              "visible_to": visible_to, "payload": payload, "prev": last["hash"] if last else GENESIS}
        ev["hash"] = event_hash(ev)
        self.conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                          (code, ev["seq"], ev["ts"], ev["actor"], ev["role"], ev["side"], etype, ev["turn"],
                           canon(visible_to), canon(payload), ev["prev"], ev["hash"]))
        return ev

    def post_event(self, code, token, data):
        etype = data.get("type")
        with self.lock:
            g = self._game(code)
            member = self._member(g["code"], token)
            if etype not in ALLOWED[member["kind"]]:
                raise ApiError(403, "Ce rôle ne peut pas enregistrer cet élément")
            if g["status"] != "running":
                raise ApiError(409, "La partie est terminée")
            visible_to, payload, turn = self._build(g, member, etype, data)
            ev = self._append(g["code"], member, etype, visible_to, payload, turn)
            if etype == "game_end":
                self.conn.execute("UPDATE games SET status='ended' WHERE code=?", (g["code"],))
            self.conn.commit()
        return ev

    def _build(self, g, member, etype, data):
        turn = None
        if etype == "move":
            payload = {"action": clean_text(data.get("action"), "action", True),
                       "reasoning": clean_text(data.get("reasoning"), "raisonnement"),
                       "expected_effect": clean_text(data.get("expected_effect"), "effet attendu")}
            return [member["side"]], payload, turn
        if etype == "adjudication":
            return self._build_adjudication(g, data)
        if etype == "inject":
            payload = {"text": clean_text(data.get("text"), "événement", True)}
            return self._audience(g, data.get("reveal_to")), payload, turn
        if etype == "turn_start":
            last = self._last(g["code"])
            label = clean_text(data.get("label"), "libellé du tour", False, 200)
            return "all", {"label": label or f"Tour {last['turn'] + 1}"}, last["turn"] + 1
        if etype == "game_end":
            return "all", {"summary": clean_text(data.get("summary"), "synthèse")}, turn
        if etype == "note":
            return ["staff"], {"text": clean_text(data.get("text"), "note", True)}, turn
        return "all", {"text": clean_text(data.get("text"), "leçon", True)}, turn  # lesson

    def _build_adjudication(self, g, data):
        ref = data.get("ref_seq")
        move = self.conn.execute("SELECT * FROM events WHERE code=? AND seq=? AND type='move'",
                                 (g["code"], ref if isinstance(ref, int) else -1)).fetchone()
        if not move:
            raise ApiError(400, "L'arbitrage doit porter sur un coup existant")
        payload = {"ref_seq": move["seq"],
                   "outcome": clean_text(data.get("outcome"), "résultat", True),
                   "rationale": clean_text(data.get("rationale"), "justification", True)}
        prob = data.get("roll_probability")
        if prob not in (None, ""):
            if not isinstance(prob, (int, float)) or isinstance(prob, bool) or not 0 <= prob <= 1:
                raise ApiError(400, "La probabilité doit être comprise entre 0 et 1")
            value = secrets.SystemRandom().random()
            payload["roll"] = {"probability": prob, "value": round(value, 4), "success": value < prob}
        audience = self._audience(g, data.get("reveal_to"), default=[move["side"]])
        return audience, payload, None

    @staticmethod
    def _audience(g, value, default="all"):
        if value == "all":
            return "all"
        if value in (None, ""):
            return default
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list) or not value or any(s not in g["sides"] for s in value):
            raise ApiError(400, "Destinataire inconnu")
        return value

    # ---------- lecture ----------
    def state(self, code, token, after=0):
        with self.lock:
            g = self._game(code)
            member = self._member(g["code"], token)
            ended = g["status"] == "ended"
            rows = self.conn.execute("SELECT * FROM events WHERE code=? AND seq>? ORDER BY seq",
                                     (g["code"], after)).fetchall()
            members = self.conn.execute("SELECT name, kind, side FROM members WHERE code=? ORDER BY joined",
                                        (g["code"],)).fetchall()
            last = self._last(g["code"])
        events = []
        for row in rows:
            ev = row_event(row)
            if visible(ev, member, ended):
                events.append(redact(ev, member, ended))
        game = {"code": g["code"], "title": g["title"], "objective": g["objective"],
                "scenario": g["scenario"], "sides": g["sides"], "status": g["status"],
                "turn": last["turn"], "head": last["hash"], "last_seq": last["seq"]}
        if member["kind"] == "adjudicator":
            game["keys"] = {"adjudicator": g["adj_key"], "observer": g["obs_key"]}
        me = {"name": member["name"], "kind": member["kind"], "side": member["side"]}
        return {"game": game, "me": me, "members": [dict(m) for m in members], "events": events}

    def verify(self, code):
        """Rejoue toute la chaîne. Une modification, un ajout ou un retrait en cours de route la brise."""
        with self.lock:
            g = self._game(code)
            rows = self.conn.execute("SELECT * FROM events WHERE code=? ORDER BY seq", (g["code"],)).fetchall()
        prev = GENESIS
        for index, row in enumerate(rows, start=1):
            ev = row_event(row)
            if ev["seq"] != index or ev["prev"] != prev or event_hash(ev) != ev["hash"]:
                return {"ok": False, "broken_at": ev["seq"], "events": len(rows)}
            prev = ev["hash"]
        return {"ok": True, "events": len(rows), "head": prev}

    def require_export(self, code, token):
        with self.lock:
            g = self._game(code)
            member = self._member(g["code"], token)
        if member["kind"] == "player" and g["status"] != "ended":
            raise ApiError(403, "L'export est réservé à l'équipe d'arbitrage jusqu'à la fin de la partie")
        return g

    def export_json(self, code, token):
        g = self.require_export(code, token)
        with self.lock:
            rows = self.conn.execute("SELECT * FROM events WHERE code=? ORDER BY seq", (g["code"],)).fetchall()
            members = self.conn.execute("SELECT name, kind, side FROM members WHERE code=?", (g["code"],)).fetchall()
        public = {k: v for k, v in g.items() if k not in ("adj_key", "obs_key")}
        return {"game": public, "members": [dict(m) for m in members],
                "events": [row_event(r) for r in rows], "verification": self.verify(code)}

    def export_markdown(self, code, token):
        data = self.export_json(code, token)
        return render_markdown(data)


TYPE_LABEL = {"game_created": "Partie créée", "joined": "Arrivée", "turn_start": "Début de tour",
              "move": "Coup", "adjudication": "Arbitrage", "inject": "Événement injecté",
              "note": "Note d'observation", "lesson": "Leçon identifiée", "game_end": "Fin de partie"}


def _audience_text(vt):
    if vt == "all":
        return "tous"
    return "équipe d'arbitrage" if vt == ["staff"] else "camp " + ", ".join(vt)


def render_event_md(ev):
    p = ev["payload"]
    who = f"{ev['actor']} ({ev['side'] or ev['role']})"
    head = f"**#{ev['seq']} · {ev['ts']} · {TYPE_LABEL.get(ev['type'], ev['type'])}** — {who} — visible : {_audience_text(ev['visible_to'])}"
    lines = [head]
    if ev["type"] == "move":
        lines += [f"- Action : {p['action']}", f"- Raisonnement : {p['reasoning'] or '—'}",
                  f"- Effet attendu : {p['expected_effect'] or '—'}"]
    elif ev["type"] == "adjudication":
        lines.append(f"- Sur le coup #{p['ref_seq']} : {p['outcome']}")
        if "roll" in p:
            r = p["roll"]
            lines.append(f"- Jet : probabilité {r['probability']}, tirage {r['value']} → "
                         f"{'réussite' if r['success'] else 'échec'}")
        lines.append(f"- Justification : {p['rationale']}")
    elif ev["type"] == "turn_start":
        lines.append(f"- {p['label']}")
    elif ev["type"] == "joined":
        lines.append(f"- {p['name']} ({p['kind']}{', ' + p['side'] if p.get('side') else ''})")
    elif ev["type"] == "game_end":
        lines.append(f"- {p.get('summary') or 'Partie terminée'}")
    elif ev["type"] != "game_created":
        lines.append(f"- {p.get('text', '')}")
    return "\n".join(lines)


def render_markdown(data):
    g, ver = data["game"], data["verification"]
    out = [f"# Compte rendu de partie — {g['title']}", "", f"**Objectif** : {g['objective']}", "",
           f"**Scénario** : {g['scenario'] or '—'}", "", f"**Camps** : {', '.join(g['sides'])}", "",
           "**Participants** : " + ", ".join(f"{m['name']} ({m['side'] or m['kind']})" for m in data["members"]), ""]
    turn = None
    for ev in data["events"]:
        if ev["type"] in ("game_created", "joined"):
            continue
        if ev["turn"] != turn:
            turn = ev["turn"]
            out += ["", f"## Tour {turn}", ""]
        out += [render_event_md(ev), ""]
    state = "intègre" if ver["ok"] else f"ROMPUE à l'événement #{ver.get('broken_at')}"
    out += ["---", f"Chaîne d'événements : {state} ({ver['events']} événements).",
            f"Empreinte finale : `{ver.get('head', '—')}`",
            "Notez cette empreinte hors de l'outil à la fin de chaque tour : elle prouve l'état du journal à cet instant."]
    return "\n".join(out)


def code_version():
    """Date de la dernière modification du code et de la configuration de la carte : sert à recharger une page restée ouverte."""
    dates = [os.path.getmtime(ZONES_FILE)] if os.path.exists(ZONES_FILE) else []
    for dossier, _, fichiers in os.walk(STATIC):
        dates += [os.path.getmtime(os.path.join(dossier, f)) for f in fichiers]
    return f"{max(dates):.3f}" if dates else "0"


def list_zones():
    """Zones de jeu déclarées dans zones.json ET présentes sur disque (une zone = un fichier .pmtiles)."""
    try:
        with open(ZONES_FILE, encoding="utf-8") as f:
            declared = json.load(f)
    except (OSError, ValueError):
        return []
    zones = []
    for key, meta in declared.items():
        if meta.get("url"):  # zone en ligne : relayée par le serveur, l'adresse source n'est pas exposée
            zones.append({"key": key, **{k: v for k, v in meta.items() if k != "url"}, "en_ligne": True})
            continue
        path = os.path.join(MAPS_DIR, f"{key}.pmtiles")
        if os.path.isfile(path):
            zones.append({"key": key, **meta, "bytes": os.path.getsize(path)})
    return zones


def _cache_lire(cle):
    with _relais_verrou:
        valeur = _relais_cache.get(cle)
        if valeur is not None:
            _relais_cache.move_to_end(cle)
        return valeur


def _cache_ecrire(cle, valeur):
    """Mémoire bornée : on retire les entrées les plus anciennes au-delà de RELAIS_CACHE_MAX."""
    global _relais_taille
    with _relais_verrou:
        if cle in _relais_cache:
            return
        _relais_cache[cle] = valeur
        _relais_taille += len(valeur[0])
        while _relais_taille > RELAIS_CACHE_MAX and _relais_cache:
            _, ancien = _relais_cache.popitem(last=False)
            _relais_taille -= len(ancien[0])


# ---------- assistant : traduit une phrase en actions proposées (jamais exécutées ici) ----------
IA_MODELE = os.environ.get("WG_IA_MODELE", "sonnet")
IA_DELAI_S = 90
IA_PROMPT_MAX = 2000
IA_CONTEXTE_MAX = 40 * 1024
IA_VERROU = threading.Lock()  # un seul appel à la fois : chaque appel consomme le forfait de l'utilisateur
IA_CONSIGNES = """Tu assistes un arbitre de wargame. Il décrit en français ce qu'il veut voir sur la carte ; tu le traduis en actions précises.
Tu ne décides jamais à sa place : tu proposes, il applique. Tu réponds uniquement par un objet JSON, sans texte autour ni balises :
{"message": "une à deux phrases en français", "actions": [ ... ]}
Actions possibles (un objet par action, champ "action") :
- {"action":"poser","modele":"<id du catalogue>","camp":"bleu|rouge","lng":nombre,"lat":nombre,"nombre":entier,"disposition":"ligne|colonne|groupe","ecartKm":nombre,"capDeg":nombre,"nom":"facultatif"}
  Pose "nombre" pièces (1 par défaut) autour du point (lng,lat), qui est le centre du groupe. ligne = côte à côte, perpendiculaires au cap
  (capDeg : 0 = nord, 90 = est ; le cap est la direction vers laquelle le groupe fait face) ; colonne = les unes derrière les autres ; groupe = en paquet.
  ecartKm = distance entre deux pièces voisines (défaut 0.3 pour du terrestre, 1 pour des UAV). Un seul objet "poser" par groupe, jamais cinq objets identiques.
- {"action":"consigne","piece":"<id ou nom exact d'une pièce du contexte>" ou "pieces":["id",...] ou "groupe":{"modele":"id","camp":"bleu|rouge"},
   "type":"aller|observer|engager","points":[[lng,lat],...],"allure":"prudente|normale|maximale","dureeMin":nombre,"cible":"<id ou nom d'une pièce>",
   "detruit":true|false}
  aller : points obligatoires ; observer : dureeMin ; engager : cible, ou "cibles":["id",...] à répartir une à une, ou "cibleGroupe":{"modele","camp"}.
  "detruit":true seulement si l'arbitre demande explicitement que la cible soit éliminée : la cible est alors détruite quand la pièce tire.
  Sinon le résultat du tir reste à sa décision. Une consigne "groupe" ou "pieces" s'applique à chaque pièce concernée.
  Les pièces posées dans la même réponse n'ont pas d'id encore : désigne-les par "groupe".
- {"action":"dessin","genre":"front|limite|zone","camp":"bleu|rouge|neutre","points":[[lng,lat],...],"nom":"facultatif"}
- {"action":"vue","lng":nombre,"lat":nombre,"zoom":nombre}
- {"action":"temps","vitesse":1|10|60|300|1800,"pause":true|false}
Règles : coordonnées en degrés décimaux, longitude d'abord. Si l'arbitre donne des coordonnées, reprends-les telles quelles. S'il nomme un lieu,
tu ne le connais que de mémoire : donne des coordonnées plausibles et dis dans "message" qu'elles sont approximatives. N'invente jamais de modèle
ni de pièce : uniquement ceux du contexte. Une pièce incapable de l'action demandée (un UAV sans arme qui engage) : ne la propose pas, explique-le.
Si la demande est ambiguë ou impossible, renvoie "actions": [] et pose la question dans "message". Pas d'emoji."""


def _extraire_json(texte):
    """Premier objet JSON équilibré d'un texte (le modèle peut ajouter des balises malgré la consigne)."""
    debut = texte.find("{")
    while debut != -1:
        profondeur, chaine, echappe = 0, False, False
        for i in range(debut, len(texte)):
            c = texte[i]
            if chaine:
                echappe = (c == "\\" and not echappe)
                if c == '"' and not echappe:
                    chaine = False
                continue
            if c == '"':
                chaine = True
            elif c == "{":
                profondeur += 1
            elif c == "}":
                profondeur -= 1
                if profondeur == 0:
                    try:
                        return json.loads(texte[debut:i + 1])
                    except ValueError:
                        break
        debut = texte.find("{", debut + 1)
    return None


def lancer_claude(entree):
    """Appelle le CLI `claude` sans outils ni réglages utilisateur ; rend le texte de la réponse."""
    import subprocess
    import tempfile
    cmd = ["claude", "-p", "--model", IA_MODELE, "--tools", "", "--no-session-persistence", "--setting-sources", "",
           "--disable-slash-commands", "--strict-mcp-config", "--system-prompt", IA_CONSIGNES, "--output-format", "json"]
    with tempfile.TemporaryDirectory() as cwd:
        try:
            r = subprocess.run(cmd, input=entree, capture_output=True, text=True, timeout=IA_DELAI_S, cwd=cwd)
        except FileNotFoundError:
            raise ApiError(503, "Le programme « claude » est introuvable sur cet ordinateur.")
        except subprocess.TimeoutExpired:
            raise ApiError(504, "L'assistant n'a pas répondu à temps.")
    try:
        sortie = json.loads(r.stdout)
    except ValueError:
        raise ApiError(502, "Réponse illisible de l'assistant.")
    if r.returncode != 0 or sortie.get("is_error"):
        raise ApiError(502, "L'assistant a refusé la demande (vérifiez que vous êtes connecté à Claude).")
    return str(sortie.get("result") or "")


def demander_ia(corps, lanceur=None):
    prompt = str(corps.get("prompt") or "").strip()
    if not prompt:
        raise ApiError(400, "Écrivez une demande.")
    if len(prompt) > IA_PROMPT_MAX:
        raise ApiError(400, f"Demande trop longue ({IA_PROMPT_MAX} caractères au plus).")
    contexte = json.dumps(corps.get("contexte") or {}, ensure_ascii=False)
    if len(contexte) > IA_CONTEXTE_MAX:
        raise ApiError(413, "Situation trop volumineuse pour l'assistant.")
    entree = f"Situation actuelle (JSON) :\n{contexte}\n\nDemande de l'arbitre :\n{prompt}"
    if not IA_VERROU.acquire(blocking=False):
        raise ApiError(429, "Une demande est déjà en cours.")
    try:
        texte = (lanceur or lancer_claude)(entree)
    finally:
        IA_VERROU.release()
    objet = _extraire_json(texte)
    if not isinstance(objet, dict):
        return {"message": texte.strip()[:1000] or "Pas de réponse exploitable.", "actions": []}
    actions = objet.get("actions")
    return {"message": str(objet.get("message") or "")[:1000], "actions": actions if isinstance(actions, list) else []}


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    store = None
    lanceur_ia = None  # remplaçable en test
    server_version = "WargameLog/0.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False))

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "Message trop long")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError(400, "JSON invalide")
        if not isinstance(data, dict):
            raise ApiError(400, "Objet JSON attendu")
        return data

    def _dispatch(self, method):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        token = self.headers.get("X-Token") or (query.get("token") or [""])[0]
        path = url.path
        if method == "GET" and path in ("/", "/carte"):
            return self._static("index.html" if path == "/" else "carte.html")
        if method == "GET" and path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if method == "GET" and path == "/api/version":
            return self._json(200, {"version": code_version()})
        if method == "GET" and path == "/api/maps":
            return self._json(200, list_zones())
        if method == "GET" and re.fullmatch(r"/enligne/[a-z0-9-]+", path):
            return self._relay_online(path[len("/enligne/"):])
        if method == "GET" and re.fullmatch(r"/maps/[a-z0-9-]+\.pmtiles", path):
            return self._send_file(os.path.join(MAPS_DIR, path[len("/maps/"):]), "application/octet-stream", cache=True)
        if method == "POST" and path == "/api/ia":
            if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                raise ApiError(403, "L'assistant n'est disponible que depuis cet ordinateur.")
            return self._json(200, demander_ia(self._body(), self.lanceur_ia))
        if method == "POST" and path == "/api/games":
            return self._json(200, self.store.create_game(self._body()))
        m = re.fullmatch(r"/api/games/([A-Za-z0-9]{5})/(info|join|events|state|verify|export)", path)
        if not m:
            raise ApiError(404, "Introuvable")
        code, action = m.group(1), m.group(2)
        if method == "GET" and action == "info":
            return self._json(200, self.store.info(code))
        if method == "POST" and action == "join":
            return self._json(200, self.store.join(code, self._body()))
        if method == "POST" and action == "events":
            return self._json(200, self.store.post_event(code, token, self._body()))
        if method == "GET" and action == "state":
            after = int((query.get("after") or ["0"])[0] or 0)
            return self._json(200, self.store.state(code, token, after))
        if method == "GET" and action == "verify":
            self.store.require_export(code, token)
            return self._json(200, self.store.verify(code))
        if method == "GET" and action == "export":
            fmt = (query.get("fmt") or ["md"])[0]
            name = f"wargame-{code.upper()}.{'json' if fmt == 'json' else 'md'}"
            disp = {"Content-Disposition": f'attachment; filename="{name}"'}
            if fmt == "json":
                return self._send(200, json.dumps(self.store.export_json(code, token), ensure_ascii=False, indent=1),
                                  extra=disp)
            return self._send(200, self.store.export_markdown(code, token), "text/markdown; charset=utf-8", disp)
        raise ApiError(405, "Méthode non autorisée")

    def _static(self, name):
        full = os.path.realpath(os.path.join(STATIC, name))
        if not full.startswith(os.path.realpath(STATIC) + os.sep):
            raise ApiError(404, "Introuvable")
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                 "mjs": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                 "woff2": "font/woff2", "txt": "text/plain; charset=utf-8"}.get(name.rsplit(".", 1)[-1],
                                                                                "application/octet-stream")
        self._send_file(full, ctype)

    def _relay_online(self, key):
        """Relaie une tranche d'une carte en ligne (le navigateur ne peut pas la lire lui-même : pas de CORS).
        L'adresse vient de zones.json, jamais du client ; la tranche doit être explicite et bornée."""
        zone = next((z for z in self._declared_zones() if z[0] == key and z[1].get("url")), None)
        m = re.fullmatch(r"bytes=(\d+)-(\d+)", (self.headers.get("Range") or "").strip())
        if not zone or not m:
            raise ApiError(404 if not zone else 416, "Introuvable" if not zone else "Plage explicite requise")
        if int(m.group(2)) < int(m.group(1)) or int(m.group(2)) - int(m.group(1)) + 1 > MAX_RELAIS:
            raise ApiError(416, "Plage trop grande")
        cle = (key, m.group(1), m.group(2))
        en_cache = _cache_lire(cle)
        if en_cache:
            data, status, content_range = en_cache
        else:
            ctx = ssl.create_default_context(cafile=CERTIFICATS) if os.path.exists(CERTIFICATS) else ssl.create_default_context()
            req = urllib.request.Request(zone[1]["url"], headers={"Range": f"bytes={m.group(1)}-{m.group(2)}", "User-Agent": "WargameLog/0.1"})
            try:
                with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                    data, status, content_range = r.read(MAX_RELAIS + 1), r.status, r.headers.get("Content-Range")
            except (urllib.error.URLError, TimeoutError, OSError):
                raise ApiError(502, "Carte en ligne indisponible")
            if len(data) > MAX_RELAIS:
                raise ApiError(502, "Réponse inattendue de la source")
            _cache_ecrire(cle, (data, status, content_range))
        extra = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600"}
        if content_range:
            extra["Content-Range"] = content_range
        self._send(206 if status == 206 else 200, data, "application/octet-stream", extra)

    @staticmethod
    def _declared_zones():
        try:
            with open(ZONES_FILE, encoding="utf-8") as f:
                return list(json.load(f).items())
        except (OSError, ValueError):
            return []

    def _byte_range(self, size):
        """Lecture partielle (en-tête Range) : indispensable pour lire un fichier PMTiles sans le charger en entier."""
        header = self.headers.get("Range")
        if not header:
            return 200, 0, size - 1
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
        if not m or not (m.group(1) or m.group(2)):
            raise ApiError(416, "Plage invalide")
        if not m.group(1):  # « les N derniers octets »
            start, end = max(size - int(m.group(2)), 0), size - 1
        else:
            start = int(m.group(1))
            end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        if start >= size or start > end:
            raise ApiError(416, "Plage hors du fichier")
        return 206, start, end

    def _send_file(self, full, ctype, cache=False):
        if not os.path.isfile(full):
            raise ApiError(404, "Introuvable")
        size = os.path.getsize(full)
        status, start, end = self._byte_range(size)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "public, max-age=3600" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        remaining = end - start + 1
        with open(full, "rb") as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _handle(self, method):
        try:
            self._dispatch(method)
        except (BrokenPipeError, ConnectionResetError):
            pass  # le navigateur a annulé la requête (tuile hors écran) : normal
        except ApiError as e:
            self._json(e.status, {"error": e.message})
        except Exception as e:  # journal serveur détaillé, message neutre au client
            print("erreur interne :", repr(e))
            self._json(500, {"error": "Erreur interne"})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def make_server(host, port, db_path):
    Handler.store = Store(db_path)
    return ThreadingHTTPServer((host, port), Handler)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--db", default=os.path.join(HERE, "wargame.db"))
    args = ap.parse_args()
    server = make_server(args.host, args.port, args.db)
    print(f"Journal de wargame prêt.\n  Cet ordinateur : http://127.0.0.1:{args.port}\n"
          f"  Réseau local   : http://{lan_address()}:{args.port}\n  Base : {args.db}\nCtrl+C pour arrêter.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")


if __name__ == "__main__":
    main()
