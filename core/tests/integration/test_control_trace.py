from test_core import CoreHarness
from core_client import Pilot, DISARM


class ControlTraceTest(CoreHarness):
    EXTRA_CONF = 'control_trace = true\n'

    def test_successful_active_frame_is_correlated_once_to_receipt(self):
        pilot = Pilot(self.client, session=903)
        self.addCleanup(pilot.stop)
        self.arm(pilot)
        import time
        time.sleep(0.2)
        pilot.paused = True
        self.client.send(DISARM, pilot.session)
        records = self.read_events()
        received = {(r['session'], r['seq']): r for r in records if r['ev'] == 'control_received'}
        serial = [r for r in records if r['ev'] == 'control_serial']
        self.assertGreater(len(serial), 3)
        keys = [(r['session'], r['seq']) for r in serial]
        self.assertEqual(len(keys), len(set(keys)), 'do not count repeated frames as new commands')
        for r in serial:
            receipt = received[(r['session'], r['seq'])]
            self.assertEqual(r['received_ns'], receipt['t_ns'])
            self.assertGreaterEqual(r['t_ns'], r['received_ns'])
            self.assertEqual(r['bytes'], 26)
        first_serial = min(r['seq'] for r in serial)
        self.assertTrue(any(seq < first_serial for (_, seq) in received), 'disarmed receipts are not deliveries')
