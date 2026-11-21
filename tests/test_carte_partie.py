import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import carte_partie as cp  # noqa: E402
import server  # noqa: E402
from server import ApiError, Store  # noqa: E402


def piece(pid, camp, type_="fantassin", **extra):
    return {"id": pid, "type": type_, "icone": type_, "categorie": "fantassin", "nom": pid.upper(), "camp": camp, "lng": 37.5, "lat": 48.5,
            "mouvement": {"min": 4, "max": 4}, "feu": {"mode": "direct", "portee_km": 0.3}, "vision": {"rayon_km": 1},
            "poste": "secret-equipe", "etat": "vol", "endurance_restante_min": 12.5, "cause_destruction": "tir", "detruit": False, **extra}


ETAT = {
    "pieces": [piece("b1", "bleu"), piece("b2", "bleu"), piece("r1", "rouge"), piece("r2", "rouge"), piece("r3", "rouge", detruit=True)],
    "ordres": {"b1": [{"id": "c1", "type": "aller", "statut": "en_cours", "points": [[37.6, 48.5]]}],
               "r1": [{"id": "c9", "type": "engager", "statut": "en_cours", "cibleId": "b1"}], "r2": [{"id": "c8", "type": "observer", "dureeMin": 5}]},
    "dessins": [{"id": "d1", "genre": "front", "camp": "bleu", "points": [[1, 1], [2, 2]]}, {"id": "d2", "genre": "front", "camp": "rouge", "points": [[3, 3], [4, 4]]},
                {"id": "d3", "genre": "limite", "camp": "neutre", "points": [[5, 5], [6, 6]]}],
    "horloge": {"ms": 1000, "vitesse": 60, "enMarche": True, "inutile": "x"},
    "visibles": {"bleu": ["r1"], "rouge": ["b1", "b2"]},
}


class Base(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(); os.close(fd)
        self.store = Store(self.db)
        self.carte = cp.CartePartie(self.store)
        g = self.store.create_game({"title": "T", "objective": "O", "name": "Arbitre", "sides": ["bleu", "rouge"]})
        self.code, self.arb = g["code"], g["token"]
        self.bleu = self.store.join(self.code, {"name": "Bleu", "kind": "player", "side": "bleu"})["token"]
        self.rouge = self.store.join(self.code, {"name": "Rouge", "kind": "player", "side": "rouge"})["token"]
        self.obs = self.store.join(self.code, {"name": "Obs", "kind": "observer", "key": g["obs_key"]})["token"]
        self.addCleanup(os.unlink, self.db)
        self.addCleanup(self.store.conn.close)

    def publier(self, etat=None):
        return self.carte.publier(self.code, self.arb, {"etat": etat or ETAT})


class VueFiltree(Base):
    def test_le_joueur_bleu_ne_recoit_que_ses_pieces_et_les_adverses_detectees(self):
        self.publier()
        v = self.carte.vue(self.code, self.bleu)
        self.assertEqual(sorted(p["id"] for p in v["pieces"]), ["b1", "b2", "r1"])
        self.assertNotIn("r2", json.dumps(v)); self.assertNotIn("r3", json.dumps(v))

    def test_une_piece_adverse_detectee_n_a_que_son_identite_et_sa_position(self):
        self.publier()
        r1 = next(p for p in self.carte.vue(self.code, self.bleu)["pieces"] if p["id"] == "r1")
        self.assertTrue(set(r1) <= set(cp.CHAMPS_ADVERSE))
        for secret in ("poste", "etat", "endurance_restante_min", "cause_destruction", "mouvement", "feu", "vision"):
            self.assertNotIn(secret, r1)
        self.assertNotIn("secret-equipe", json.dumps([p for p in self.carte.vue(self.code, self.bleu)["pieces"] if p["camp"] == "rouge"]))

    def test_les_ordres_adverses_ne_sont_jamais_envoyes(self):
        self.publier()
        v = self.carte.vue(self.code, self.bleu)
        self.assertEqual(sorted(v["ordres"]), ["b1"])
        for cle in ("c9", "c8", "r1", "r2"):
            self.assertNotIn(f'"{cle}"', json.dumps(v["ordres"]))

    def test_les_traces_adverses_sont_masques_les_neutres_et_les_siens_visibles(self):
        self.publier()
        self.assertEqual(sorted(d["id"] for d in self.carte.vue(self.code, self.bleu)["dessins"]), ["d1", "d3"])
        self.assertEqual(sorted(d["id"] for d in self.carte.vue(self.code, self.rouge)["dessins"]), ["d2", "d3"])

    def test_les_routes_coupees_sont_publiques_pour_les_deux_camps(self):
        coupures = [{"lng": 37.5, "lat": 48.5, "rayonM": 15}]
        self.publier({**ETAT, "coupures": coupures})
        for jeton in (self.bleu, self.rouge, self.arb):
            self.assertEqual(self.carte.vue(self.code, jeton)["coupures"], coupures)

    def test_la_liste_des_detections_n_est_pas_envoyee_au_joueur(self):
        self.publier()
        v = self.carte.vue(self.code, self.bleu)
        self.assertNotIn("visibles", v); self.assertNotIn("visibles", json.dumps(v))

    def test_le_joueur_rouge_voit_ses_pieces_et_les_bleues_detectees(self):
        self.publier()
        self.assertEqual(sorted(p["id"] for p in self.carte.vue(self.code, self.rouge)["pieces"]), ["b1", "b2", "r1", "r2", "r3"])

    def test_aucune_detection_aucune_piece_adverse(self):
        self.publier({**ETAT, "visibles": {}})
        self.assertEqual(sorted(p["id"] for p in self.carte.vue(self.code, self.bleu)["pieces"]), ["b1", "b2"])

    def test_l_arbitre_voit_tout(self):
        self.publier()
        v = self.carte.vue(self.code, self.arb)
        self.assertEqual(len(v["pieces"]), 5); self.assertEqual(len(v["ordres"]), 3); self.assertEqual(len(v["dessins"]), 3)
        self.assertEqual(v["pieces"][0]["poste"], "secret-equipe")

    def test_l_horloge_est_commune_et_reduite_aux_champs_connus(self):
        self.publier()
        self.assertEqual(self.carte.vue(self.code, self.bleu)["horloge"], {"ms": 1000, "vitesse": 60, "enMarche": True})

    def test_la_revision_evite_de_renvoyer_un_etat_inchange(self):
        rev = self.publier()["rev"]
        self.assertNotIn("pieces", self.carte.vue(self.code, self.bleu, rev)); self.assertTrue(self.carte.vue(self.code, self.bleu, rev)["inchange"])
        self.assertEqual(self.publier()["rev"], rev + 1)
        self.assertIn("pieces", self.carte.vue(self.code, self.bleu, rev))

    def test_avant_toute_publication_la_vue_est_vide(self):
        self.assertTrue(self.carte.vue(self.code, self.bleu)["vide"])


class Droits(Base):
    def test_seul_l_arbitre_publie_et_lit_l_etat_complet(self):
        for jeton in (self.bleu, self.rouge, self.obs, "faux"):
            with self.assertRaises(ApiError): self.carte.publier(self.code, jeton, {"etat": ETAT})
            with self.assertRaises(ApiError): self.carte.etat_complet(self.code, jeton)
        self.publier()
        self.assertEqual(len(self.carte.etat_complet(self.code, self.arb)["etat"]["pieces"]), 5)

    def test_un_observateur_n_a_pas_de_vue_de_la_carte(self):
        self.publier()
        with self.assertRaises(ApiError) as cm: self.carte.vue(self.code, self.obs)
        self.assertEqual(cm.exception.status, 403)

    def test_un_jeton_d_une_autre_partie_est_refuse(self):
        autre = self.store.create_game({"title": "T2", "objective": "O", "name": "A2", "sides": ["bleu", "rouge"]})
        self.publier()
        with self.assertRaises(ApiError) as cm: self.carte.vue(self.code, autre["token"])
        self.assertEqual(cm.exception.status, 401)

    def test_seul_l_arbitre_liste_et_traite_les_ordres_ou_poste_des_evenements(self):
        self.publier()
        cid = self.carte.commander(self.code, self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})["id"]
        for jeton in (self.bleu, self.rouge):
            with self.assertRaises(ApiError): self.carte.commandes_en_attente(self.code, jeton)
            with self.assertRaises(ApiError): self.carte.resultat_commande(self.code, jeton, cid, {"ok": True})
            with self.assertRaises(ApiError): self.carte.evenements(self.code, jeton, {"evenements": [{"texte": "x", "visible_to": "all"}]})

    def test_un_joueur_ne_peut_pas_forger_un_evenement_de_carte_par_l_api_du_journal(self):
        with self.assertRaises(ApiError) as cm: self.store.post_event(self.code, self.bleu, {"type": "carte_event", "text": "x"})
        self.assertEqual(cm.exception.status, 403)

    def test_etat_trop_gros_ou_mal_forme_refuse(self):
        for etat in ({"pieces": [{"id": "x", "camp": "vert"}]}, {"pieces": [{"camp": "bleu"}]}, "texte", None):
            with self.assertRaises(ApiError): self.carte.publier(self.code, self.arb, {"etat": etat})
        gros = {"pieces": [], "dessins": [{"camp": "bleu", "nom": "x" * 10000}] * 300}
        with self.assertRaises(ApiError) as cm: self.carte.publier(self.code, self.arb, {"etat": gros})
        self.assertEqual(cm.exception.status, 413)


class Ordres(Base):
    def setUp(self):
        super().setUp(); self.publier()

    def cmd(self, jeton, corps): return self.carte.commander(self.code, jeton, corps)

    def test_un_joueur_commande_ses_pieces(self):
        r = self.cmd(self.bleu, {"type": "consigne", "pieceId": "b1", "consigne": {"type": "aller", "allure": "normale", "points": [[37.6, 48.6]]}})
        self.assertEqual(r["statut"], "attente")
        en_attente = self.carte.commandes_en_attente(self.code, self.arb)["commandes"]
        self.assertEqual([(c["side"], c["corps"]["pieceId"]) for c in en_attente], [("bleu", "b1")])

    def test_un_joueur_ne_commande_jamais_une_piece_adverse_inconnue_ou_detruite(self):
        consigne = {"type": "observer", "dureeMin": 5}
        for pid, code in (("r1", 403), ("r2", 403), ("zzz", 403), (None, 403)):
            with self.assertRaises(ApiError) as cm: self.cmd(self.bleu, {"type": "consigne", "pieceId": pid, "consigne": consigne})
            self.assertEqual(cm.exception.status, code, pid)
        with self.assertRaises(ApiError) as cm: self.cmd(self.rouge, {"type": "consigne", "pieceId": "r3", "consigne": consigne})
        self.assertEqual(cm.exception.status, 409)

    def test_viser_une_piece_non_detectee_est_refuse_par_le_serveur(self):
        with self.assertRaises(ApiError) as cm: self.cmd(self.bleu, {"type": "consigne", "pieceId": "b1", "consigne": {"type": "engager", "cibleId": "r2"}})
        self.assertEqual(cm.exception.status, 403)
        self.cmd(self.bleu, {"type": "consigne", "pieceId": "b1", "consigne": {"type": "engager", "cibleId": "r1"}})

    def test_consignes_mal_formees_refusees(self):
        mauvaises = [{"type": "aller", "points": []}, {"type": "aller", "points": [[999, 0]]}, {"type": "aller", "points": [[1, 2, 3]]}, {"type": "aller", "points": "x"},
                     {"type": "observer", "dureeMin": -1}, {"type": "observer", "dureeMin": True}, {"type": "engager"}, {"type": "detruire"}, {"type": "aller", "allure": "vite", "points": [[1, 1]]}, "x"]
        for c in mauvaises:
            with self.assertRaises(ApiError, msg=str(c)): self.cmd(self.bleu, {"type": "consigne", "pieceId": "b1", "consigne": c})
        with self.assertRaises(ApiError): self.cmd(self.bleu, {"type": "teleporter", "pieceId": "b1"})

    def test_seuls_les_champs_connus_sont_conserves(self):
        self.cmd(self.bleu, {"type": "consigne", "pieceId": "b1", "consigne": {"type": "observer", "dureeMin": 5, "detruit": True, "camp": "rouge", "statut": "terminee"}})
        corps = self.carte.commandes_en_attente(self.code, self.arb)["commandes"][0]["corps"]
        self.assertEqual(corps["consigne"], {"type": "observer", "dureeMin": 5})

    def test_le_resultat_n_est_visible_que_de_l_auteur(self):
        cid = self.cmd(self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})["id"]
        self.carte.resultat_commande(self.code, self.arb, cid, {"ok": False, "message": "Pièce occupée"})
        mien = self.carte.vue(self.code, self.bleu)["commandes"]
        self.assertEqual((mien[0]["statut"], mien[0]["reponse"]), ("refusee", "Pièce occupée"))
        self.assertEqual(self.carte.vue(self.code, self.rouge)["commandes"], [])
        with self.assertRaises(ApiError) as cm: self.carte.resultat_commande(self.code, self.arb, cid, {"ok": True})
        self.assertEqual(cm.exception.status, 404)

    def test_le_resultat_arrive_meme_si_l_etat_n_a_pas_change(self):
        rev = self.publier()["rev"]
        cid = self.cmd(self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})["id"]
        self.carte.resultat_commande(self.code, self.arb, cid, {"ok": True, "message": "ok"})
        v = self.carte.vue(self.code, self.bleu, rev)
        self.assertTrue(v["inchange"]); self.assertEqual(v["commandes"][0]["statut"], "traitee")

    def test_trop_d_ordres_en_attente(self):
        for _ in range(cp.MAX_COMMANDES_ATTENTE): self.cmd(self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})
        with self.assertRaises(ApiError) as cm: self.cmd(self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})
        self.assertEqual(cm.exception.status, 429)
        self.cmd(self.rouge, {"type": "annuler", "pieceId": "r1", "consigneId": "c9"})  # l'autre camp n'est pas bloqué

    def test_l_ordre_est_trace_dans_la_chaine_pour_son_camp_seulement(self):
        self.cmd(self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})
        types = lambda jeton: [e["type"] for e in self.store.state(self.code, jeton)["events"]]  # noqa: E731
        self.assertIn("carte_order", types(self.bleu)); self.assertNotIn("carte_order", types(self.rouge)); self.assertIn("carte_order", types(self.arb))
        self.assertTrue(self.store.verify(self.code)["ok"])


class Journal(Base):
    def test_les_evenements_respectent_leur_public(self):
        self.carte.evenements(self.code, self.arb, {"evenements": [
            {"texte": "pour tous", "genre": "info", "t": 1, "visible_to": "all"}, {"texte": "pour bleu", "genre": "tir", "t": 2, "visible_to": ["bleu"]},
            {"texte": "pour rouge", "genre": "contact", "t": 3, "visible_to": ["rouge"]}, {"texte": "arbitre seul", "genre": "op", "t": 4, "visible_to": []},
            {"texte": "les deux", "genre": "tir", "t": 5, "visible_to": ["bleu", "rouge"]}]})
        textes = lambda jeton: sorted(e["payload"]["texte"] for e in self.store.state(self.code, jeton)["events"] if e["type"] == "carte_event")  # noqa: E731
        self.assertEqual(textes(self.bleu), ["les deux", "pour bleu", "pour tous"])
        self.assertEqual(textes(self.rouge), ["les deux", "pour rouge", "pour tous"])
        self.assertEqual(len(textes(self.arb)), 5)
        self.assertTrue(self.store.verify(self.code)["ok"])

    def test_public_inconnu_ou_lot_invalide_refuses(self):
        for lot in ([{"texte": "x", "visible_to": ["vert"]}], [{"texte": "x"}], [], [{"texte": " ", "visible_to": "all"}], "x", [{"texte": "x", "visible_to": "all"}] * (cp.MAX_EVENEMENTS_LOT + 1)):
            with self.assertRaises(ApiError, msg=str(lot)): self.carte.evenements(self.code, self.arb, {"evenements": lot})

    def test_l_export_n_est_pas_casse_par_les_nouveaux_types(self):
        self.publier()
        self.carte.commander(self.code, self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})
        self.carte.evenements(self.code, self.arb, {"evenements": [{"texte": "Frappe", "genre": "tir", "t": 1, "visible_to": "all"}]})
        md = self.store.export_markdown(self.code, self.arb)
        self.assertIn("Frappe", md); self.assertIn("Ordre donné sur la carte", md)


class Http(Base):
    def setUp(self):
        super().setUp()
        self.httpd = server.make_server("127.0.0.1", 0, self.db)
        server.Handler.lanceur_ia = staticmethod(lambda e: '{"message":"ok","actions":[]}')
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.httpd.shutdown(), self.httpd.server_close(), setattr(server.Handler, "lanceur_ia", None)))
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        # make_server rouvre le Store sur la même base : on rejoue donc la création dans CE serveur
        g = server.Handler.store.create_game({"title": "H", "objective": "O", "name": "Arb", "sides": ["bleu", "rouge"]})
        self.code, self.arb = g["code"], g["token"]
        self.bleu = server.Handler.store.join(self.code, {"name": "B", "kind": "player", "side": "bleu"})["token"]

    def appel(self, methode, chemin, jeton=None, corps=None):
        req = urllib.request.Request(self.base + chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None,
                                     headers={"Content-Type": "application/json", **({"X-Token": jeton} if jeton else {})})
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e: return e.code, json.load(e)

    def test_parcours_complet_par_http(self):
        self.assertEqual(self.appel("POST", f"/api/games/{self.code}/carte", self.arb, {"etat": ETAT})[0], 200)
        s, v = self.appel("GET", f"/api/games/{self.code}/carte/vue", self.bleu)
        self.assertEqual((s, sorted(p["id"] for p in v["pieces"])), (200, ["b1", "b2", "r1"]))
        self.assertEqual(self.appel("GET", f"/api/games/{self.code}/carte/etat", self.bleu)[0], 403)
        self.assertEqual(self.appel("POST", f"/api/games/{self.code}/carte", self.bleu, {"etat": ETAT})[0], 403)
        self.assertEqual(self.appel("GET", f"/api/games/{self.code}/carte/vue")[0], 401)
        s, c = self.appel("POST", f"/api/games/{self.code}/carte/commandes", self.bleu, {"type": "annuler", "pieceId": "b1", "consigneId": "c1"})
        self.assertEqual(s, 200)
        s, att = self.appel("GET", f"/api/games/{self.code}/carte/commandes", self.arb)
        self.assertEqual(len(att["commandes"]), 1)
        self.assertEqual(self.appel("POST", f"/api/games/{self.code}/carte/commandes/{c['id']}", self.arb, {"ok": True, "message": "fait"})[0], 200)
        self.assertEqual(self.appel("POST", f"/api/games/{self.code}/carte/evenements", self.arb, {"evenements": [{"texte": "x", "visible_to": "all"}]})[0], 200)

    def test_l_assistant_est_ouvert_aux_participants_et_pas_aux_inconnus_hors_de_cette_machine(self):
        hors = type("H", (), {"client_address": ("192.168.1.9", 1)})()
        self.assertTrue(server.Handler.store.est_participant(self.code, self.bleu)); self.assertTrue(server.Handler.store.est_participant(self.code, self.arb))
        self.assertFalse(server.Handler.store.est_participant(self.code, "faux")); self.assertFalse(server.Handler.store.est_participant("ZZZZZ", self.bleu))
        obs = server.Handler.store.join(self.code, {"name": "O", "kind": "observer", "key": server.Handler.store.state(self.code, self.arb)["game"]["keys"]["observer"]})["token"]
        self.assertFalse(server.Handler.store.est_participant(self.code, obs)); self.assertIsNotNone(hors)
        s, r = self.appel("POST", "/api/ia", self.bleu, {"prompt": "salut"})
        self.assertEqual(s, 200)  # depuis cette machine, comme avant


if __name__ == "__main__":
    unittest.main()
