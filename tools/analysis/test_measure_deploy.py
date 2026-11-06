from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'deploy' / 'measure-control.sh'


class MeasurementDeploymentTest(unittest.TestCase):
    def run_guard(self, state):
        body = '''source "$1"
systemctl() { echo "systemctl $*"; }
read_core_state() { echo "$2"; }
stop_disarmed_core
'''
        # Shell functions replace systemctl/status only within this subprocess.
        body = body.replace('echo "$2"', 'echo ' + state)
        return subprocess.run(['bash', '-c', body, '--', str(SCRIPT)], capture_output=True, text=True)

    def test_arm_during_backup_refuses_core_stop_and_restores_gateway(self):
        r = self.run_guard('ARMED')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('systemctl stop gcs-gateway', r.stdout)
        self.assertNotIn('systemctl stop crsf-core', r.stdout)
        self.assertIn('systemctl start gcs-gateway', r.stdout)

    def test_disarmed_stop_blocks_pilot_input_before_stopping_core(self):
        r = self.run_guard('DISARMED')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ['systemctl stop gcs-gateway', 'systemctl stop crsf-core'])
