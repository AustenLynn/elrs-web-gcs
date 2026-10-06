import os
import subprocess
import unittest

from fake_tx import FakeTx

PARAM = os.path.join(os.path.dirname(__file__), "..", "..", "build", "crsf-param")


class ParamTest(unittest.TestCase):
    def setUp(self):
        self.tx = FakeTx()
        self.addCleanup(self.tx.close)

    def run_tool(self, *args):
        return subprocess.run([PARAM, self.tx.path, *args], capture_output=True, text=True, timeout=30)

    def test_list_shows_settings_with_values_and_folders(self):
        out = self.run_tool("list")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("FAKE TX, ExpressLRS 3.5.3, 6 settings", out.stdout)
        self.assertIn("[ 1] Packet Rate: 250Hz(-108dbm)", out.stdout)
        self.assertIn("[ 3] TX Power: (folder)", out.stdout)
        self.assertIn("  [ 4] Max Power: 100 mW", out.stdout)       # indented under the folder
        self.assertIn("[ 6] Bad/Good: 0/250", out.stdout)
        self.assertNotIn('""', out.stdout)                           # hidden options not shown

    def test_set_changes_value_and_confirms(self):
        out = self.run_tool("set", "packet rate", "500")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Packet Rate: 250Hz(-108dbm) -> 500Hz(-105dbm)", out.stdout)
        self.assertEqual(self.tx.param("Packet Rate")[5], 4)

    def test_set_unknown_option_fails_without_writing(self):
        out = self.run_tool("set", "Max Power", "2000")
        self.assertEqual(out.returncode, 1)
        self.assertIn("has no option starting with \"2000\"", out.stderr)
        self.assertEqual(self.tx.param("Max Power")[5], 3)

    def test_set_unknown_setting_fails(self):
        out = self.run_tool("set", "Warp Drive", "on")
        self.assertEqual(out.returncode, 1)
        self.assertIn("no selectable setting named", out.stderr)


if __name__ == "__main__":
    unittest.main()
