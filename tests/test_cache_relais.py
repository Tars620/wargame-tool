import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


class CacheDisque(unittest.TestCase):
    def setUp(self):
        self.dossier = tempfile.mkdtemp()
        self.ancien = server.CACHE_DISQUE
        server.CACHE_DISQUE = self.dossier
        server._relais_cache.clear()
        server._relais_taille = 0

    def tearDown(self):
        server.CACHE_DISQUE = self.ancien
        server._relais_cache.clear()
        server._relais_taille = 0

    def test_une_tranche_ecrite_survit_a_un_redemarrage(self):
        cle = ("planete", "0", "16383")
        server._cache_ecrire(cle, (b"\x00\x01octets\n", 206, "bytes 0-16383/999"))
        server._relais_cache.clear()  # redémarrage : la mémoire est vide
        server._relais_taille = 0
        self.assertEqual(server._cache_lire(cle), (b"\x00\x01octets\n", 206, "bytes 0-16383/999"))
        self.assertIn(cle, server._relais_cache, "relue du disque, elle repasse en mémoire")

    def test_une_tranche_inconnue_ou_abimee_est_ignoree(self):
        cle = ("planete", "1", "2")
        self.assertIsNone(server._cache_lire(cle))
        os.makedirs(self.dossier, exist_ok=True)
        with open(server._chemin_disque(cle), "wb") as f:
            f.write(b"pas du json\n???")
        self.assertIsNone(server._cache_lire(cle))

    def test_un_disque_inaccessible_ne_casse_pas_la_carte(self):
        server.CACHE_DISQUE = os.path.join(self.dossier, "fichier")
        open(server.CACHE_DISQUE, "w").close()  # un fichier à la place du dossier : l'écriture échoue
        server._cache_ecrire(("p", "0", "1"), (b"x", 206, None))
        self.assertEqual(server._cache_lire(("p", "0", "1"))[0], b"x")  # la mémoire a servi quand même

    def test_l_elagage_retire_les_plus_anciennes(self):
        server.CACHE_DISQUE_MAX, ancien = 100, server.CACHE_DISQUE_MAX
        try:
            for i in range(5):
                server._cache_ecrire(("p", str(i), "9"), (b"x" * 40, 206, None))
                os.utime(server._chemin_disque(("p", str(i), "9")), (1000 + i, 1000 + i))
            server._disque_elaguer()
            restants = os.listdir(self.dossier)
            self.assertLessEqual(sum(os.path.getsize(os.path.join(self.dossier, n)) for n in restants), 100)
            self.assertTrue(os.path.exists(server._chemin_disque(("p", "4", "9"))), "la plus récente est gardée")
            self.assertFalse(os.path.exists(server._chemin_disque(("p", "0", "9"))), "la plus ancienne part")
        finally:
            server.CACHE_DISQUE_MAX = ancien


if __name__ == "__main__":
    unittest.main()
