import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

PARTIE = {"title": "t", "objective": "o", "scenario": "", "name": "Arbitre", "sides": ["bleu", "rouge"]}
DISTANT = {"X-Forwarded-For": "203.0.113.9", "Host": "wargame.example", "X-Forwarded-Proto": "https"}


class ServeurHeberge(unittest.TestCase):
    """Un serveur en ligne : les visiteurs distants passent par un proxy (en-têtes X-Forwarded-*), la création de parties exige une clé."""

    @classmethod
    def setUpClass(cls):
        cls.cle_avant = server.CLE_CREATION
        server.CLE_CREATION = "cle-de-test"
        cls.db = tempfile.mktemp(suffix=".db")
        cls.srv = server.make_server("127.0.0.1", 0, cls.db)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        server.CLE_CREATION = cls.cle_avant
        cls.srv.shutdown(); cls.srv.server_close(); os.unlink(cls.db)

    def appeler(self, methode, chemin, en_tetes=None, corps=None):
        req = urllib.request.Request(self.base + chemin, method=methode, headers={"Content-Type": "application/json", **(en_tetes or {})},
                                     data=json.dumps(corps).encode() if corps is not None else None)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def test_un_visiteur_distant_recoit_les_liens_de_l_adresse_par_laquelle_il_est_arrive(self):
        statut, acces = self.appeler("GET", "/api/acces", DISTANT)
        self.assertEqual(statut, 200)
        self.assertEqual(acces["reseau"], "https://wargame.example")
        self.assertEqual(acces["adresses"], [])  # jamais le réseau interne de la machine
        self.assertTrue(acces["public"])

    def test_creer_une_partie_a_distance_exige_la_cle(self):
        self.assertEqual(self.appeler("POST", "/api/games", DISTANT, PARTIE)[0], 403)
        self.assertEqual(self.appeler("POST", "/api/games", {**DISTANT, "X-Cle-Creation": "mauvaise"}, PARTIE)[0], 403)
        self.assertEqual(self.appeler("POST", "/api/games", {**DISTANT, "X-Cle-Creation": "cle-de-test"}, PARTIE)[0], 200)

    def test_depuis_l_ordinateur_lui_meme_la_cle_n_est_pas_demandee(self):
        self.assertEqual(self.appeler("POST", "/api/games", None, PARTIE)[0], 200)

    def test_le_lien_internet_et_l_assistant_local_ne_se_pilotent_pas_a_distance(self):
        self.assertEqual(self.appeler("GET", "/api/tunnel", DISTANT)[0], 403)
        self.assertEqual(self.appeler("POST", "/api/tunnel", DISTANT)[0], 403)
        self.assertEqual(self.appeler("POST", "/api/ia", DISTANT, {"demande": "x"})[0], 403)


if __name__ == "__main__":
    unittest.main()


class SousAdresse(unittest.TestCase):
    """Servi sous /wargame/ derrière un proxy : les pages renvoient des adresses préfixées et le serveur retire le préfixe."""

    def setUp(self):
        self.avant = server.PREFIXE
        server.PREFIXE = "/wargame"
        server._STATIQUE.clear()
        self.db = tempfile.mktemp(suffix=".db")
        self.srv = server.make_server("127.0.0.1", 0, self.db)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        server.PREFIXE = self.avant
        server._STATIQUE.clear()
        self.srv.shutdown(); self.srv.server_close(); os.unlink(self.db)

    def lire(self, chemin, en_tetes=None):
        req = urllib.request.Request(self.base + chemin, headers=en_tetes or {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, ""

    def test_avec_prefixe_ne_touche_que_les_adresses_absolues_de_l_application(self):
        self.assertEqual(server.avec_prefixe("fetch('/api/x'); import('./a.js'); `${o}/carte?p=1`; url(/static/f.woff2); <a href=\"/\">"),
                         "fetch('/wargame/api/x'); import('./a.js'); `${o}/wargame/carte?p=1`; url(/wargame/static/f.woff2); <a href=\"/wargame/\">")
        self.assertEqual(server.avec_prefixe("a /apis b mot/static"), "a /apis b mot/static")
        # un sous-chemin d'API après ${...} ne reçoit PAS le préfixe une seconde fois (/api/games/X est déjà préfixé)
        self.assertEqual(server.avec_prefixe("`/api/games/${c}`; `${base()}/carte/commandes`; `${origine}/carte?partie=X`; `pmtiles://${o}/enligne/${k}`"),
                         "`/wargame/api/games/${c}`; `${base()}/carte/commandes`; `${origine}/wargame/carte?partie=X`; `pmtiles://${o}/wargame/enligne/${k}`")

    def test_la_page_et_ses_scripts_sont_servis_sous_le_prefixe(self):
        statut, html = self.lire("/wargame/carte")
        self.assertEqual(statut, 200)
        self.assertIn('src="/wargame/static/', html)
        self.assertNotIn('src="/static/', html)
        statut, js = self.lire("/wargame/static/partie.js")
        self.assertEqual(statut, 200)
        self.assertIn("/wargame/api/", js)

    def test_hors_du_prefixe_c_est_introuvable_et_sans_barre_finale_on_redirige(self):
        self.assertEqual(self.lire("/carte")[0], 404)
        self.assertEqual(self.lire("/wargame/api/version")[0], 200)
        req = urllib.request.Request(self.base + "/wargame")
        opener = urllib.request.build_opener(type("N", (urllib.request.HTTPRedirectHandler,), {"redirect_request": lambda *a, **k: None}))
        with self.assertRaises(urllib.error.HTTPError) as c:
            opener.open(req)
        self.assertEqual(c.exception.code, 301)

    def test_les_liens_a_donner_portent_le_prefixe(self):
        statut, corps = self.lire("/wargame/api/acces", {"X-Forwarded-For": "1.2.3.4", "Host": "exemple.fr", "X-Forwarded-Proto": "https"})
        self.assertEqual(statut, 200)
        self.assertEqual(json.loads(corps)["reseau"], "https://exemple.fr")  # l'adresse du site ; le préfixe est ajouté aux liens par les pages elles-mêmes


class AssistantParApi(unittest.TestCase):
    """Sur un serveur, l'assistant appelle une API avec la clé du serveur ; les visiteurs n'ont rien à fournir, mais leur nombre de demandes est plafonné."""

    def setUp(self):
        self.sauve = {k: getattr(server, k) for k in ("IA_CLE_ANTHROPIC", "IA_URL_COMPATIBLE", "IA_CLE_COMPATIBLE", "IA_PAR_HEURE_ET_VISITEUR", "IA_PAR_JOUR", "_post_json")}
        server._IA_JOURNAL.update({"visiteurs": {}, "jour": (None, 0)})

    def tearDown(self):
        for k, v in self.sauve.items():
            setattr(server, k, v)

    def test_sans_cle_l_assistant_reste_celui_de_l_ordinateur_local(self):
        server.IA_CLE_ANTHROPIC = server.IA_CLE_COMPATIBLE = server.IA_URL_COMPATIBLE = ""
        self.assertFalse(server.ia_par_api())

    def test_anthropic_la_reponse_est_le_texte_des_blocs(self):
        server.IA_CLE_ANTHROPIC = "cle-test"
        vus = {}
        def faux(url, en_tetes, corps):
            vus.update(url=url, cle=en_tetes.get("x-api-key"), modele=corps["model"], consignes=bool(corps["system"]))
            return {"content": [{"type": "text", "text": '{"message": "ok", '}, {"type": "text", "text": '"actions": []}'}]}
        server._post_json = faux
        self.assertTrue(server.ia_par_api())
        self.assertEqual(server.lancer_api("demande"), '{"message": "ok", "actions": []}')
        self.assertEqual(vus["url"], "https://api.anthropic.com/v1/messages")
        self.assertEqual(vus["cle"], "cle-test")
        self.assertTrue(vus["consignes"])

    def test_fournisseur_compatible_openai(self):
        server.IA_CLE_ANTHROPIC = ""
        server.IA_URL_COMPATIBLE, server.IA_CLE_COMPATIBLE = "https://exemple.test/chat", "k"
        server._post_json = lambda url, en_tetes, corps: {"choices": [{"message": {"content": "bonjour"}}]} if en_tetes["Authorization"] == "Bearer k" else {}
        self.assertEqual(server.lancer_api("x"), "bonjour")

    def test_plafonds_par_visiteur_et_par_jour(self):
        server.IA_PAR_HEURE_ET_VISITEUR, server.IA_PAR_JOUR = 2, 3
        t = 1_700_000_000
        server.limiter_ia("a", t); server.limiter_ia("a", t + 1)
        with self.assertRaises(server.ApiError) as c:
            server.limiter_ia("a", t + 2)
        self.assertEqual(c.exception.status, 429)
        server.limiter_ia("a", t + 3700)  # une heure plus tard, le visiteur peut de nouveau demander
        with self.assertRaises(server.ApiError):
            server.limiter_ia("b", t + 3701)  # plafond du jour atteint pour tout le monde
        server.limiter_ia("b", t + 90000)  # le lendemain, c'est reparti

    def test_une_panne_du_fournisseur_est_une_erreur_claire(self):
        def panne(url, en_tetes, corps):
            raise server.ApiError(502, "L'assistant est indisponible (erreur 401 du fournisseur).")
        server.IA_CLE_ANTHROPIC = "mauvaise"
        server._post_json = panne
        with self.assertRaises(server.ApiError) as c:
            server.demander_ia({"prompt": "x", "contexte": {}})
        self.assertEqual(c.exception.status, 502)


class RelaisIA(unittest.TestCase):
    """L'IA d'un serveur en ligne peut tourner sur un ordinateur relais, avec une clé et une heure limite."""

    def setUp(self):
        self.sauve = {k: getattr(server, k) for k in ("RELAIS_CLE", "RELAIS_JUSQUA", "IA_RELAIS_URL", "IA_RELAIS_CLE", "IA_CLE_ANTHROPIC", "lancer_claude", "_post_json")}
        self.db = tempfile.mktemp(suffix=".db")
        self.srv = server.make_server("127.0.0.1", 0, self.db)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        for k, v in self.sauve.items():
            setattr(server, k, v)
        self.srv.shutdown(); self.srv.server_close(); os.unlink(self.db)

    def relais(self, cle):
        req = urllib.request.Request(self.base + "/api/ia-relais", method="POST", data=json.dumps({"entree": "bonjour"}).encode(),
                                     headers={"Content-Type": "application/json", "X-Relais-Cle": cle})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_le_relais_exige_la_cle_et_s_arrete_a_l_heure_limite(self):
        import time
        server.lancer_claude = lambda entree: "réponse de " + entree
        server.RELAIS_CLE, server.RELAIS_JUSQUA = "k", time.time() + 60
        self.assertEqual(self.relais("k"), (200, {"texte": "réponse de bonjour"}))
        self.assertEqual(self.relais("autre")[0], 403)
        server.RELAIS_JUSQUA = time.time() - 1
        self.assertEqual(self.relais("k")[0], 403)  # heure limite passée : fermé même avec la bonne clé

    def test_sans_configuration_le_relais_est_ferme(self):
        server.RELAIS_CLE = ""
        self.assertEqual(self.relais("")[0], 403)

    def test_le_serveur_en_ligne_envoie_la_demande_au_relais(self):
        server.IA_CLE_ANTHROPIC = ""
        server.IA_RELAIS_URL, server.IA_RELAIS_CLE = "https://mon-mac.test", "k"
        vu = {}
        def faux(url, en_tetes, corps):
            vu.update(url=url, cle=en_tetes.get("X-Relais-Cle"))
            return {"texte": '{"message": "depuis le Mac", "actions": []}'}
        server._post_json = faux
        self.assertTrue(server.ia_par_api())
        self.assertEqual(server.demander_ia({"prompt": "x", "contexte": {}})["message"], "depuis le Mac")
        self.assertEqual(vu, {"url": "https://mon-mac.test/api/ia-relais", "cle": "k"})
