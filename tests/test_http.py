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

PAYLOAD = bytes(range(256)) * 8  # 2048 octets reconnaissables


class HttpCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(cls.tmp, "maps"))
        with open(os.path.join(cls.tmp, "maps", "zone-a.pmtiles"), "wb") as f:
            f.write(PAYLOAD)
        zones = os.path.join(cls.tmp, "zones.json")
        with open(zones, "w") as f:
            json.dump({"zone-a": {"label": "A"}, "zone-absente": {"label": "B"}}, f)
        server.MAPS_DIR, server.ZONES_FILE = os.path.join(cls.tmp, "maps"), zones
        cls.srv = server.make_server("127.0.0.1", 0, os.path.join(cls.tmp, "t.db"))
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

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


class RouteTests(HttpCase):
    def test_unknown_or_unsafe_map_names_are_not_served(self):
        for path in ("/maps/absente.pmtiles", "/maps/../server.py", "/maps/zone-a.txt", "/maps/ZONE-A.pmtiles"):
            self.assertEqual(self.get(path)[0], 404, path)

    def test_static_traversal_is_refused(self):
        self.assertEqual(self.get("/static/../server.py")[0], 404)

    def test_api_maps_lists_only_zones_present_on_disk(self):
        zones = json.loads(self.get("/api/maps")[2])
        self.assertEqual([z["key"] for z in zones], ["zone-a"])
        self.assertEqual(zones[0]["bytes"], len(PAYLOAD))

    def test_pages_are_served(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.get("/carte")[0], 200)


if __name__ == "__main__":
    unittest.main()
