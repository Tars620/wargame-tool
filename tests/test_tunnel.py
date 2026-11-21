import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

PYTHON = sys.executable


def faux(script):
    """Faux programme de tunnel : un petit script Python qui imprime ce que ferait cloudflared."""
    return lambda: ("faux", [PYTHON, "-c", script])


def attendre(tunnel, etat, delai=5):
    fin = time.time() + delai
    while time.time() < fin:
        if tunnel.statut()["etat"] == etat:
            return True
        time.sleep(0.05)
    return False


class GestionDuTunnel(unittest.TestCase):
    def test_l_adresse_du_tunnel_est_lue_dans_la_sortie_du_programme(self):
        t = server.Tunnel(8080, faux("import time\nprint('Votre lien : https://abc-def-12.trycloudflare.com ok', flush=True)\ntime.sleep(30)"))
        self.addCleanup(t.arreter)
        self.assertEqual(t.statut()["etat"], "arret")
        t.demarrer()
        self.assertTrue(attendre(t, "actif"))
        self.assertEqual(t.statut()["url"], "https://abc-def-12.trycloudflare.com")
        self.assertEqual(t.arreter()["etat"], "arret")
        self.assertIsNone(t.statut()["url"])

    def test_un_programme_qui_s_arrete_sans_adresse_donne_une_erreur_lisible(self):
        t = server.Tunnel(8080, faux("print('connexion refusée')"))
        self.addCleanup(t.arreter)
        t.demarrer()
        self.assertTrue(attendre(t, "erreur"))
        self.assertIn("connexion refusée", t.statut()["message"])

    def test_sans_programme_de_tunnel_le_message_dit_quoi_installer(self):
        t = server.Tunnel(8080, lambda: (None, None))
        t.demarrer()
        self.assertEqual(t.statut()["etat"], "erreur")
        self.assertIn("cloudflared", t.statut()["message"])

    def test_demarrer_deux_fois_ne_lance_qu_un_programme(self):
        t = server.Tunnel(8080, faux("import time\nprint('https://un-seul.trycloudflare.com', flush=True)\ntime.sleep(30)"))
        self.addCleanup(t.arreter)
        t.demarrer()
        premier = t.proc
        t.demarrer()
        self.assertIs(t.proc, premier)

    def test_la_commande_par_defaut_vise_le_serveur_local_et_jamais_une_autre_adresse(self):
        t = server.Tunnel(8123)
        via, cmd = t._commande_par_defaut()
        if cmd:
            self.assertTrue(any("127.0.0.1:8123" in a for a in cmd))
            self.assertFalse(any("0.0.0.0" in a for a in cmd))


class RoutesLocalesSeulement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fd, cls.db = tempfile.mkstemp(); os.close(fd)
        cls.srv = server.make_server("127.0.0.1", 0, cls.db)
        cls.srv.RequestHandlerClass.tunnel = server.Tunnel(cls.srv.server_address[1], lambda: (None, None))
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close(); os.unlink(cls.db)

    def appeler(self, methode, chemin, en_tetes=None, corps=None):
        req = urllib.request.Request(self.base + chemin, method=methode, headers=en_tetes or {}, data=json.dumps(corps).encode() if corps is not None else None)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def test_depuis_cet_ordinateur_le_lien_internet_se_gere(self):
        self.assertEqual(self.appeler("GET", "/api/tunnel")[1]["etat"], "arret")
        self.assertEqual(self.appeler("POST", "/api/tunnel")[1]["etat"], "erreur")  # pas de programme dans ce test
        self.assertEqual(self.appeler("DELETE", "/api/tunnel")[1]["etat"], "arret")

    def test_une_requete_relayee_par_un_tunnel_n_est_pas_locale(self):
        """Un tunnel relaie les visiteurs distants depuis 127.0.0.1 : sans ce contrôle ils piloteraient le tunnel et l'assistant."""
        for en_tete in ("X-Forwarded-For", "Cf-Connecting-Ip", "Forwarded", "X-Real-Ip"):
            status, _ = self.appeler("POST", "/api/tunnel", {en_tete: "203.0.113.9"})
            self.assertEqual(status, 403, en_tete)
            status, corps = self.appeler("POST", "/api/ia", {en_tete: "203.0.113.9", "Content-Type": "application/json"}, {"prompt": "x", "contexte": {}})
            self.assertEqual(status, 403, en_tete)

    def test_l_acces_donne_les_adresses_du_reseau_et_l_etat_du_lien_internet(self):
        status, corps = self.appeler("GET", "/api/acces")
        self.assertEqual(status, 200)
        self.assertTrue(corps["reseau"].startswith("http://"))
        self.assertIsInstance(corps["adresses"], list)
        self.assertEqual(corps["tunnel"]["etat"], "arret")


if __name__ == "__main__":
    unittest.main()
