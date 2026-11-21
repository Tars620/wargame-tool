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
