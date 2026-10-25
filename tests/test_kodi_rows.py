"""Profile contract checks without ADB or a running Kodi."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


loader = importlib.machinery.SourceFileLoader("tvctl_test", str(Path(__file__).resolve().parents[1] / "tvctl"))
spec = importlib.util.spec_from_loader(loader.name, loader)
tvctl = importlib.util.module_from_spec(spec)
loader.exec_module(tvctl)


class KodiRowsConfigTest(unittest.TestCase):
    def setUp(self):
        self.movie = {"id": "movies", "name": "Movies", "paths": ["plugin://movies/recent"],
                      "max": 40, "exclude_ratings": ["R"]}
        self.live = {"id": "live", "name": "Live TV", "type": "live", "channels": [
            {"id": "rtk3", "name": "RTK 3", "url": "https://example.org/rtk3.m3u8",
             "source": "https://example.org/tv"}]}
        self.ctx = SimpleNamespace(prof={"kodi": {"rows": [self.movie, self.live]}})

    def config(self):
        return json.loads(tvctl.kodi_rows_config(self.ctx))

    def test_adding_live_row_preserves_movie_config(self):
        self.ctx.prof["kodi"]["rows"] = [self.movie]
        previous = self.config()["rows"][0]
        self.ctx.prof["kodi"]["rows"].append(self.live)
        self.assertEqual(self.config()["rows"][0], previous)
        self.assertNotIn("type", previous)  # existing movie config stays byte-compatible

    def test_live_channels_keep_profile_order_and_source(self):
        self.live["channels"].append({"id": "ktv", "name": "KTV", "url": "https://example.org/ktv.m3u8"})
        live = self.config()["rows"][1]
        self.assertNotIn("paths", live)
        self.assertEqual([c["id"] for c in live["channels"]], ["rtk3", "ktv"])
        self.assertEqual(live["channels"][0]["source"], "https://example.org/tv")

    def test_rejects_duplicate_channel_ids(self):
        self.live["channels"].append(dict(self.live["channels"][0]))
        with self.assertRaises(tvctl.TvError):
            self.config()

    def test_rejects_empty_live_row(self):
        self.live["channels"] = []
        with self.assertRaises(tvctl.TvError):
            self.config()

    def test_rejects_local_file_streams(self):
        self.live["channels"][0]["url"] = "file:///sdcard/private"
        with self.assertRaises(tvctl.TvError):
            self.config()

    def test_rejects_unknown_row_type(self):
        self.live["type"] = "unknown"
        with self.assertRaises(tvctl.TvError):
            self.config()

    def test_fresh_link_resolvers_are_preserved(self):
        for resolver in ("gjirafa", "klan"):
            self.live["channels"][0]["resolver"] = resolver
            self.assertEqual(self.config()["rows"][1]["channels"][0]["resolver"], resolver)

    def test_rejects_unknown_resolver(self):
        self.live["channels"][0]["resolver"] = "unknown"
        with self.assertRaises(tvctl.TvError):
            self.config()

    def test_radio_row_keeps_tv_and_movies_unchanged(self):
        previous = self.config()["rows"]
        station = {"id": "dukagjini", "name": "Radio Dukagjini", "resolver": "gjirafa",
                   "url": "https://example.org/radio-metadata"}
        self.ctx.prof["kodi"]["rows"].append({"id": "radio", "name": "Kosovo Radio", "type": "radio",
                                            "channels": [station]})
        rows = self.config()["rows"]
        self.assertEqual(rows[:2], previous)
        self.assertEqual(rows[2], {"id": "radio", "name": "Kosovo Radio", "type": "radio", "channels": [station]})

    def test_radio_can_use_direct_audio_without_file_extension(self):
        self.live.update(type="radio", channels=[{"id": "radio", "name": "Radio", "url": "https://example.org/live"}])
        self.assertEqual(self.config()["rows"][1]["channels"][0]["url"], "https://example.org/live")


class ChannelPackTest(unittest.TestCase):
    def setUp(self):
        self.movie = {"id": "movies", "name": "Movies", "paths": ["plugin://movies/recent"]}
        self.pack = {"rows": [{"id": "pack-live", "name": "Pack TV", "type": "live", "channels": [
            {"id": "one", "name": "One", "url": "https://example.org/one.m3u8"}]}]}
        self.real_packs = tvctl.load_packs
        tvctl.load_packs = lambda: {"test": self.pack}

    def tearDown(self):
        tvctl.load_packs = self.real_packs

    def test_pack_rows_follow_profile_rows(self):
        prof = {"kodi": {"rows": [self.movie], "packs": ["test"]}}
        self.assertEqual([r["id"] for r in tvctl.kodi_rows(prof)], ["movies", "pack-live"])

    def test_pack_alone_is_enough(self):
        self.assertEqual([r["id"] for r in tvctl.kodi_rows({"kodi": {"packs": ["test"]}})], ["pack-live"])

    def test_profile_row_with_same_id_wins(self):
        own = {"id": "pack-live", "name": "My TV", "type": "live", "channels": []}
        rows = tvctl.kodi_rows({"kodi": {"rows": [own], "packs": ["test"]}})
        self.assertEqual(rows, [own])

    def test_unknown_pack_is_an_error(self):
        with self.assertRaises(tvctl.TvError):
            tvctl.kodi_rows({"kodi": {"packs": ["nope"]}})


class ShippedPacksTest(unittest.TestCase):
    def test_every_pack_is_a_valid_config(self):
        packs = tvctl.load_packs()
        self.assertIn("kosovo", packs)
        for pack_id in packs:
            ctx = SimpleNamespace(prof={"kodi": {"packs": [pack_id]}})
            rows = json.loads(tvctl.kodi_rows_config(ctx))["rows"]
            self.assertTrue(rows and all(r["type"] in ("live", "radio") for r in rows), pack_id)
            self.assertTrue(packs[pack_id].get("name") and packs[pack_id].get("note"), pack_id)


if __name__ == "__main__":
    unittest.main()
