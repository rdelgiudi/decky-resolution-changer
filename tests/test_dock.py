"""Run with: python3 -I tests/test_dock.py  (no decky install needed)."""
import os, sys, tempfile, types, unittest

# Stub the decky module so main.py imports outside Decky Loader.
stub = types.ModuleType("decky")
stub.logger = types.SimpleNamespace(info=print, warning=print, error=print)
sys.modules["decky"] = stub
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import main  # noqa: E402


class FakeDrm:
    def __init__(self):
        self.root = tempfile.mkdtemp()

    def set(self, name, status):
        d = os.path.join(self.root, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "status"), "w") as f:
            f.write(status + "\n")

    @property
    def glob(self):
        return os.path.join(self.root, "card*-*")


class TestClassification(unittest.TestCase):
    def test_connector_type(self):
        self.assertEqual(main.connector_type("/sys/class/drm/card1-eDP-1"), "eDP")
        self.assertEqual(main.connector_type("card0-HDMI-A-1"), "HDMI-A")
        self.assertEqual(main.connector_type("card1-DP-10"), "DP")
        self.assertEqual(main.connector_type("card0-Writeback-1"), "Writeback")

    def test_external_connected(self):
        c = {"card0-eDP-1": "connected", "card0-DP-1": "connected",
             "card0-DP-2": "disconnected", "card0-Writeback-1": "unknown",
             "card0-DSI-1": "connected"}
        self.assertEqual(main.external_connected(c), ["card0-DP-1"])


class TestDebounce(unittest.TestCase):
    def setUp(self):
        self.drm = FakeDrm()
        self.drm.set("card0-eDP-1", "connected")
        self.drm.set("card0-DP-1", "disconnected")
        self.drm.set("card0-Writeback-1", "unknown")
        self.w = main.DockWatcher(self.drm.glob, debounce_s=2.0)

    def run_polls(self, t0, t1, step=1.0):
        events, t = [], t0
        while t <= t1:
            if self.w.poll(t):
                events.append((t, self.w.docked))
            t += step
        return events

    def test_initial_handheld(self):
        self.assertFalse(self.w.docked)

    def test_initial_docked(self):
        self.drm.set("card0-DP-1", "connected")
        self.assertTrue(main.DockWatcher(self.drm.glob).docked)

    def test_single_dock_and_undock(self):
        self.drm.set("card0-DP-1", "connected")
        ev = self.run_polls(0, 10)
        self.assertEqual(len(ev), 1)
        self.assertTrue(ev[0][1])
        self.assertGreaterEqual(ev[0][0], 2.0)
        self.drm.set("card0-DP-1", "disconnected")
        ev = self.run_polls(11, 20)
        self.assertEqual([d for _, d in ev], [False])

    def test_flapping_gives_one_final_state(self):
        events = []
        t = 0.0
        # Plug/unplug every second, 3 times: never stable for 2 s.
        for status in ["connected", "disconnected"] * 3:
            self.drm.set("card0-DP-1", status)
            if self.w.poll(t):
                events.append(self.w.docked)
            t += 1.0
        self.assertEqual(events, [])
        self.drm.set("card0-DP-1", "connected")
        for _ in range(5):
            if self.w.poll(t):
                events.append(self.w.docked)
            t += 1.0
        self.assertEqual(events, [True])

    def test_flap_back_to_original_emits_nothing(self):
        self.drm.set("card0-DP-1", "connected")
        self.assertFalse(self.w.poll(0))
        self.drm.set("card0-DP-1", "disconnected")
        self.assertEqual(self.run_polls(1, 10), [])


class TestSettings(unittest.TestCase):
    def test_roundtrip_and_validation(self):
        stub.DECKY_PLUGIN_SETTINGS_DIR = tempfile.mkdtemp()
        self.assertEqual(main.load_settings(), main.DEFAULT_SETTINGS)
        main.save_settings({"handheld": "1280x800", "docked": 5, "autoSwitch": False})
        s = main.load_settings()
        self.assertEqual(s, {"handheld": "1280x800", "docked": "1920x1080", "autoSwitch": False})


if __name__ == "__main__":
    unittest.main(verbosity=2)
