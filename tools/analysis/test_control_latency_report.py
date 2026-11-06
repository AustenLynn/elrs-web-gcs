import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
from control_latency_report import analyse, main, read_jsonl


def fixture(n=10):
    sent = {'version': 1, 'sent': n, 'overflow': False, 'commands': []}
    gateway, core = [], []
    for seq in range(1, n + 1):
        t = seq * 20_000_000
        sent['commands'].append({'session': 7, 'seq': seq, 'ts': seq * 20.0})
        gateway.append({'ev': 'control', 'session': 7, 'seq': seq, 'browser_ts_ms': seq * 20.0,
                        'recv_ns': str(t), 'forward_ns': str(t + 2_000_000), 'outcome': 'forwarded',
                        'network_ms': 12, 'sync_error_ms': 2, 'sync_age_ms': 500, 'via': 'local'})
        core.extend([{'ev': 'control_received', 'session': 7, 'seq': seq, 't_ns': t + 3_000_000},
                     {'ev': 'control_serial', 'session': 7, 'seq': seq, 't_ns': t + 7_000_000,
                      'received_ns': t + 3_000_000, 'bytes': 26}])
    return sent, gateway, core


class ControlLatencyTest(unittest.TestCase):
    def test_breakdown_and_conservative_target_over_ten_thousand_commands(self):
        r = analyse(*fixture(10000))
        self.assertTrue(r['pass'])
        self.assertEqual(r['segments']['network']['p90'], 12)
        self.assertEqual(r['segments']['gateway']['p90'], 2)
        self.assertEqual(r['segments']['core']['p90'], 5)
        self.assertEqual(r['segments']['total']['p90'], 19)
        self.assertEqual(r['within_upper'], 10000)

    def test_missing_and_superseded_commands_remain_in_denominator(self):
        s, g, c = fixture()
        g.pop()  # not observed by gateway
        c = [r for r in c if not (r['seq'] == 9 and r['ev'] == 'control_serial')]
        r = analyse(s, g, c, min_commands=10)
        self.assertEqual(r['sent'], 10)
        self.assertEqual(r['complete'], 8)
        self.assertEqual(r['outcomes']['missing_gateway'], 1)
        self.assertEqual(r['outcomes']['not_submitted'], 1)
        self.assertFalse(r['pass'])

    def test_uncertainty_can_prevent_a_pass_without_hiding_estimated_result(self):
        s, g, c = fixture()
        for r in g:
            r['network_ms'] = 42  # total 49, upper 51
        r = analyse(s, g, c, min_commands=10)
        self.assertEqual(r['within_estimate'], 10)
        self.assertEqual(r['within_upper'], 0)
        self.assertFalse(r['pass'])

    def test_tunnel_and_stale_clock_are_not_local_acceptance_evidence(self):
        for field, value in [('via', 'tunnel'), ('sync_age_ms', 20000), ('network_ms', None)]:
            s, g, c = fixture()
            for row in g:
                row[field] = value
            self.assertFalse(analyse(s, g, c, min_commands=10)['pass'])

    def test_clock_negative_estimate_is_not_clamped_into_a_fast_success(self):
        s, g, c = fixture()
        g[0]['network_ms'] = -1
        r = analyse(s, g, c, min_commands=10)
        self.assertEqual(r['outcomes']['invalid_timing'], 1)

    def test_duplicates_overflow_and_timestamp_mismatch_invalidate_capture(self):
        for change in ('duplicate_sent', 'duplicate_gateway', 'duplicate_serial', 'overflow', 'timestamp'):
            s, g, c = copy.deepcopy(fixture())
            if change == 'duplicate_sent': s['commands'].append(s['commands'][0])
            if change == 'duplicate_gateway': g.append(g[0])
            if change == 'duplicate_serial': c.append(c[1])
            if change == 'overflow': s['overflow'] = True
            if change == 'timestamp': g[0]['browser_ts_ms'] += 100
            r = analyse(s, g, c, min_commands=10)
            self.assertFalse(r['pass'], change)
            self.assertTrue(r['problems'], change)

    def test_partial_serial_write_is_never_delivery(self):
        s, g, c = fixture()
        c[1]['bytes'] = 12
        r = analyse(s, g, c, min_commands=10)
        self.assertEqual(r['complete'], 9)
        self.assertEqual(r['outcomes']['invalid_timing'], 1)

    def test_stale_and_core_down_are_explicit_outcomes(self):
        s, g, c = fixture()
        g[0]['outcome'] = 'stale'
        g[1]['outcome'] = 'core_down'
        r = analyse(s, g, c)
        self.assertEqual(r['outcomes']['stale'], 1)
        self.assertEqual(r['outcomes']['core_down'], 1)
        self.assertFalse(r['pass'], 'fewer than 10000 commands')

    def test_serial_must_match_its_receipt_and_monotonic_order(self):
        for change in ('receipt', 'order', 'nan'):
            s, g, c = fixture()
            if change == 'receipt': c[1]['received_ns'] += 1
            if change == 'order': c[1]['t_ns'] = 0
            if change == 'nan': g[0]['network_ms'] = float('nan')
            r = analyse(s, g, c, min_commands=10)
            self.assertEqual(r['complete'], 9)


class DamagedLogTest(unittest.TestCase):
    """A power cut leaves NUL bytes or a half-written last line in the JSONL logs."""

    def write(self, folder, name, text):
        path = os.path.join(folder, name)
        with open(path, 'w', newline='') as f:
            f.write(text)
        return path

    def test_nul_padding_and_truncated_line_are_skipped_and_counted(self):
        with tempfile.TemporaryDirectory() as d:
            good = json.dumps({'ev': 'control', 'seq': 1})
            path = self.write(d, 'g.jsonl', good + '\n' + '\x00' * 300 + '\n{"ev":"contr\n\n')
            records, damaged = read_jsonl(path)
        self.assertEqual(records, [{'ev': 'control', 'seq': 1}])
        self.assertEqual(damaged, 2)

    def test_nul_bytes_before_a_valid_record_do_not_lose_it(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, 'c.jsonl', '\x00\x00' + json.dumps({'ev': 'state'}) + '\n')
            records, damaged = read_jsonl(path)
        self.assertEqual(records, [{'ev': 'state'}])
        self.assertEqual(damaged, 0)

    def test_report_runs_on_damaged_logs_and_says_how_many_lines_it_skipped(self):
        s, g, c = fixture()
        with tempfile.TemporaryDirectory() as d:
            sent = self.write(d, 'sent.json', json.dumps(s))
            gw = self.write(d, 'gateway.jsonl', ''.join(json.dumps(r) + '\n' for r in g) + '\x00' * 64)
            core = self.write(d, 'core.jsonl', ''.join(json.dumps(r) + '\n' for r in c) + '{"ev":\n')
            out = os.path.join(d, 'report.json')
            text = io.StringIO()
            with contextlib.redirect_stdout(text):
                code = main([sent, gw, core, '--json', out])
            with open(out) as f:
                report = json.load(f)
        self.assertEqual(code, 1)  # 10 commands: valid data, but below the 10,000 minimum
        self.assertEqual(report['complete'], 10)
        self.assertEqual(report['damaged_lines'], {'gateway': 1, 'core': 1})
        self.assertIn('Skipped damaged log lines: gateway 1, core 1', text.getvalue())


if __name__ == '__main__':
    unittest.main()
