import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

PAYLOAD = bytes(range(256)) * 8  # 2048 octets reconnaissables


class Upstream(BaseHTTPRequestHandler):
    """Faux serveur de carte en ligne : sert PAYLOAD par tranches."""
    hits = 0

    def do_GET(self):
        Upstream.hits += 1
        m = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range", ""))
        a, b = (int(m.group(1)), min(int(m.group(2)), len(PAYLOAD) - 1)) if m else (0, len(PAYLOAD) - 1)
        body = PAYLOAD[a:b + 1]
        self.send_response(206 if m else 200)
        self.send_header("Content-Length", str(len(body)))
        if m:
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(PAYLOAD)}")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class HttpCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(cls.tmp, "maps"))
        with open(os.path.join(cls.tmp, "maps", "zone-a.pmtiles"), "wb") as f:
            f.write(PAYLOAD)
        cls.upstream = HTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        zones = os.path.join(cls.tmp, "zones.json")
        with open(zones, "w") as f:
            json.dump({"zone-a": {"label": "A"}, "zone-absente": {"label": "B"},
                       "en-ligne": {"label": "Planète", "maxzoom": 15,
                                    "url": f"http://127.0.0.1:{cls.upstream.server_address[1]}/planete.pmtiles"}}, f)
        server.MAPS_DIR, server.ZONES_FILE = os.path.join(cls.tmp, "maps"), zones
        cls.srv = server.make_server("127.0.0.1", 0, os.path.join(cls.tmp, "t.db"))
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.upstream.shutdown()

    def get(self, path, rng=None):
        req = urllib.request.Request(self.base + path, headers={"Range": rng} if rng else {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()


class RangeTests(HttpCase):
    def test_full_file_without_range(self):
        status, headers, body = self.get("/maps/zone-a.pmtiles")
        self.assertEqual((status, body), (200, PAYLOAD))
        self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_partial_range_returns_exactly_those_bytes(self):
        status, headers, body = self.get("/maps/zone-a.pmtiles", "bytes=10-19")
        self.assertEqual((status, body), (206, PAYLOAD[10:20]))
        self.assertEqual(headers["Content-Range"], "bytes 10-19/2048")

    def test_open_ended_and_suffix_ranges(self):
        self.assertEqual(self.get("/maps/zone-a.pmtiles", "bytes=2040-")[2], PAYLOAD[2040:])
        self.assertEqual(self.get("/maps/zone-a.pmtiles", "bytes=-8")[2], PAYLOAD[-8:])

    def test_end_beyond_file_is_clamped(self):
        status, _, body = self.get("/maps/zone-a.pmtiles", "bytes=2000-9999")
        self.assertEqual((status, body), (206, PAYLOAD[2000:]))

    def test_invalid_ranges_are_refused(self):
        for rng in ("bytes=5000-6000", "bytes=20-10", "bytes=-", "octets=1-2"):
            self.assertEqual(self.get("/maps/zone-a.pmtiles", rng)[0], 416, rng)


class OnlineRelayTests(HttpCase):
    def test_relays_exactly_the_requested_range(self):
        status, headers, body = self.get("/enligne/en-ligne", "bytes=100-199")
        self.assertEqual((status, body), (206, PAYLOAD[100:200]))
        self.assertEqual(headers["Content-Range"], "bytes 100-199/2048")

    def test_a_repeated_range_is_served_from_memory(self):
        self.get("/enligne/en-ligne", "bytes=300-399")
        avant = Upstream.hits
        status, _, body = self.get("/enligne/en-ligne", "bytes=300-399")
        self.assertEqual((status, body, Upstream.hits), (206, PAYLOAD[300:400], avant))

    def test_the_memory_is_bounded(self):
        server._relais_cache.clear(); server._relais_taille = 0
        ancien, server.RELAIS_CACHE_MAX = server.RELAIS_CACHE_MAX, 250
        try:
            for debut in (0, 100, 200, 300):
                self.get("/enligne/en-ligne", f"bytes={debut}-{debut + 99}")
            self.assertLessEqual(server._relais_taille, 250)
        finally:
            server.RELAIS_CACHE_MAX = ancien

    def test_requires_an_explicit_bounded_range(self):
        for rng in (None, "bytes=0-", "bytes=-10", "bytes=50-10", f"bytes=0-{server.MAX_RELAIS + 5}"):
            self.assertEqual(self.get("/enligne/en-ligne", rng)[0], 416, rng)

    def test_only_declared_online_zones_are_relayed(self):
        self.assertEqual(self.get("/enligne/zone-a", "bytes=0-9")[0], 404)  # zone locale : pas de relais
        self.assertEqual(self.get("/enligne/inconnue", "bytes=0-9")[0], 404)
        self.assertEqual(self.get("/enligne/../server", "bytes=0-9")[0], 404)


class RouteTests(HttpCase):
    def test_unknown_or_unsafe_map_names_are_not_served(self):
        for path in ("/maps/absente.pmtiles", "/maps/../server.py", "/maps/zone-a.txt", "/maps/ZONE-A.pmtiles"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_static_traversal_is_refused(self):
        self.assertEqual(self.get("/static/../server.py")[0], 404)

    def test_api_maps_lists_disk_zones_and_online_zones_without_exposing_the_source_url(self):
        zones = {z["key"]: z for z in json.loads(self.get("/api/maps")[2])}
        self.assertEqual(sorted(zones), ["en-ligne", "zone-a"])
        self.assertEqual(zones["zone-a"]["bytes"], len(PAYLOAD))
        self.assertTrue(zones["en-ligne"]["en_ligne"])
        self.assertNotIn("url", zones["en-ligne"])

    def test_pages_are_served(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.get("/carte")[0], 200)


if __name__ == "__main__":
    unittest.main()
