import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402
from server import ApiError, Store  # noqa: E402


class GameCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.tmp, "t.db"))
        g = self.store.create_game({"title": "Test", "objective": "Tester", "scenario": "S",
                                    "name": "Arbitre", "sides": ["Bleu", "Rouge"]})
        self.code, self.adj = g["code"], g["token"]
        self.keys = self.store.state(self.code, self.adj)["game"]["keys"]
        self.blue = self.join("Alice", "player", "Bleu")
        self.red = self.join("Bob", "player", "Rouge")
        self.obs = self.join("Obs", "observer", key=self.keys["observer"])

    def join(self, name, kind, side=None, key=None):
        return self.store.join(self.code, {"name": name, "kind": kind, "side": side, "key": key})["token"]

    def post(self, token, **data):
        return self.store.post_event(self.code, token, data)

    def move(self, token, text="Avancer"):
        return self.post(token, type="move", action=text, reasoning="pourquoi", expected_effect="effet")

    def seqs(self, token):
        return [e["seq"] for e in self.store.state(self.code, token)["events"]]


class ChainTests(GameCase):
    def test_chain_is_valid_after_normal_play(self):
        self.move(self.blue)
        self.assertTrue(self.store.verify(self.code)["ok"])

    def test_editing_an_event_breaks_the_chain_at_that_event(self):
        ev = self.move(self.blue)
        self.store.conn.execute("UPDATE events SET payload=? WHERE code=? AND seq=?",
                                ('{"action":"truque","expected_effect":"","reasoning":""}', self.code, ev["seq"]))
        res = self.store.verify(self.code)
        self.assertFalse(res["ok"])
        self.assertEqual(res["broken_at"], ev["seq"])

    def test_deleting_an_event_breaks_the_chain(self):
        ev = self.move(self.blue)
        self.move(self.red)
        self.store.conn.execute("DELETE FROM events WHERE code=? AND seq=?", (self.code, ev["seq"]))
        self.assertFalse(self.store.verify(self.code)["ok"])


class FogTests(GameCase):
    def test_a_move_is_hidden_from_the_other_side_but_not_from_staff(self):
        ev = self.move(self.blue)
        self.assertIn(ev["seq"], self.seqs(self.blue))
        self.assertNotIn(ev["seq"], self.seqs(self.red))
        self.assertIn(ev["seq"], self.seqs(self.adj))
        self.assertIn(ev["seq"], self.seqs(self.obs))

    def test_rationale_is_hidden_from_players_until_the_end(self):
        mv = self.move(self.blue)
        adj = self.post(self.adj, type="adjudication", ref_seq=mv["seq"], outcome="Réussi", rationale="secret", reveal_to="all")
        seen = {e["seq"]: e for e in self.store.state(self.code, self.red)["events"]}
        self.assertNotIn("rationale", seen[adj["seq"]]["payload"])
        self.post(self.adj, type="game_end", summary="fin")
        seen = {e["seq"]: e for e in self.store.state(self.code, self.red)["events"]}
        self.assertEqual(seen[adj["seq"]]["payload"]["rationale"], "secret")
        self.assertIn(mv["seq"], seen)

    def test_adjudication_defaults_to_the_mover_side_only(self):
        mv = self.move(self.blue)
        adj = self.post(self.adj, type="adjudication", ref_seq=mv["seq"], outcome="o", rationale="r")
        self.assertIn(adj["seq"], self.seqs(self.blue))
        self.assertNotIn(adj["seq"], self.seqs(self.red))

    def test_staff_notes_are_never_shown_to_players(self):
        note = self.post(self.obs, type="note", text="observation")
        self.assertNotIn(note["seq"], self.seqs(self.blue))
        self.assertIn(note["seq"], self.seqs(self.adj))


class PermissionTests(GameCase):
    def test_a_player_cannot_adjudicate_or_inject(self):
        mv = self.move(self.blue)
        for data in ({"type": "adjudication", "ref_seq": mv["seq"], "outcome": "o", "rationale": "r"},
                     {"type": "inject", "text": "x"}, {"type": "turn_start"}, {"type": "game_end"}):
            with self.assertRaises(ApiError) as ctx:
                self.store.post_event(self.code, self.blue, data)
            self.assertEqual(ctx.exception.status, 403)

    def test_joining_as_staff_needs_the_right_key(self):
        with self.assertRaises(ApiError) as ctx:
            self.join("Intrus", "adjudicator", key="nope")
        self.assertEqual(ctx.exception.status, 403)
        with self.assertRaises(ApiError):
            self.join("Intrus", "observer", key=self.keys["adjudicator"])

    def test_unknown_token_is_rejected(self):
        with self.assertRaises(ApiError) as ctx:
            self.store.state(self.code, "faux")
        self.assertEqual(ctx.exception.status, 401)

    def test_players_cannot_export_before_the_end(self):
        with self.assertRaises(ApiError):
            self.store.export_markdown(self.code, self.blue)
        self.post(self.adj, type="game_end")
        self.assertIn("Chaîne d'événements : intègre", self.store.export_markdown(self.code, self.blue))

    def test_no_new_event_after_the_end(self):
        self.post(self.adj, type="game_end")
        with self.assertRaises(ApiError) as ctx:
            self.move(self.blue)
        self.assertEqual(ctx.exception.status, 409)


class InputTests(GameCase):
    def test_adjudication_needs_a_rationale_and_an_existing_move(self):
        mv = self.move(self.blue)
        with self.assertRaises(ApiError):
            self.post(self.adj, type="adjudication", ref_seq=mv["seq"], outcome="o", rationale="")
        with self.assertRaises(ApiError):
            self.post(self.adj, type="adjudication", ref_seq=9999, outcome="o", rationale="r")

    def test_roll_is_recorded_with_probability(self):
        mv = self.move(self.blue)
        ok = self.post(self.adj, type="adjudication", ref_seq=mv["seq"], outcome="o", rationale="r", roll_probability=1)
        ko = self.post(self.adj, type="adjudication", ref_seq=mv["seq"], outcome="o", rationale="r", roll_probability=0)
        self.assertTrue(ok["payload"]["roll"]["success"])
        self.assertFalse(ko["payload"]["roll"]["success"])
        with self.assertRaises(ApiError):
            self.post(self.adj, type="adjudication", ref_seq=mv["seq"], outcome="o", rationale="r", roll_probability=2)

    def test_text_fields_are_bounded(self):
        with self.assertRaises(ApiError):
            self.move(self.blue, "x" * (server.MAX_TEXT + 1))

    def test_a_game_needs_two_distinct_sides(self):
        with self.assertRaises(ApiError):
            self.store.create_game({"title": "t", "objective": "o", "name": "n", "sides": ["A", "A"]})

    def test_turns_advance(self):
        self.post(self.adj, type="turn_start", label="J+1")
        mv = self.move(self.blue)
        self.assertEqual(mv["turn"], 2)


if __name__ == "__main__":
    unittest.main()
