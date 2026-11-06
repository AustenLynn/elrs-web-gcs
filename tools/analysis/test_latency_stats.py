"""Tests for latency_stats.py (statistical summary and capability of control latency)."""
import csv
import io
import json
import math
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from statistics import NormalDist

import latency_stats as ls


def normal_sample(n, mu=10.0, sigma=2.0):
    """A deterministic sample with the exact shape of a normal distribution."""
    d = NormalDist(mu, sigma)
    return [d.inv_cdf((i + 0.5) / n) for i in range(n)]


class DescriptiveTest(unittest.TestCase):
    def test_quartiles_use_the_n_plus_1_rule(self):
        x = [1, 2, 3, 4, 5, 6, 7, 8]
        s = ls.describe(x)
        self.assertAlmostEqual(s['q1'], 2.25)
        self.assertAlmostEqual(s['median'], 4.5)
        self.assertAlmostEqual(s['q3'], 6.75)
        self.assertAlmostEqual(s['mean'], 4.5)
        self.assertAlmostEqual(s['sd'], math.sqrt(6.0))

    def test_symmetric_data_has_no_skew_and_right_tail_has_positive_skew(self):
        self.assertAlmostEqual(ls.describe(normal_sample(1000))['skewness'], 0.0, places=6)
        self.assertGreater(ls.describe([1] * 50 + [2] * 30 + [10, 30, 60])['skewness'], 2)

    def test_mean_interval_contains_the_mean(self):
        s = ls.describe(normal_sample(400))
        lo, hi = s['mean_ci']
        self.assertLess(lo, s['mean'])
        self.assertGreater(hi, s['mean'])
        self.assertAlmostEqual(hi - lo, 2 * 1.966 * s['sd'] / 20, places=2)


class NormalityTest(unittest.TestCase):
    def test_normal_data_is_not_rejected(self):
        a = ls.anderson_darling(normal_sample(500))
        self.assertGreater(a['p'], 0.5)

    def test_skewed_latency_like_data_is_rejected(self):
        x = [math.exp(v) for v in normal_sample(2000, 1.5, 0.6)]
        a = ls.anderson_darling(x)
        self.assertLess(a['p'], 0.005)
        b = ls.anderson_darling([math.log(v) for v in x])   # it is lognormal
        self.assertGreater(b['p'], 0.5)

    def test_extreme_departure_is_rejected_not_wrapped_to_p_one(self):
        # Like the measured latency: a tight body and a long tail. A2 is in the hundreds,
        # where the p-value approximation's quadratic turns back up if left unbounded.
        x = [4.0 + (i % 100) / 50 for i in range(19000)] + [40.0 + i for i in range(300)]
        a = ls.anderson_darling(x)
        self.assertGreater(a['a2'], 200)
        self.assertLess(a['p'], 0.005)


class CapabilityTest(unittest.TestCase):
    def test_normal_data_gives_the_textbook_ppk(self):
        c = ls.capability(normal_sample(5000, 10, 2), usl=22)   # (22 - 10) / (3 * 2) = 2.0
        self.assertAlmostEqual(c['normal']['ppk'], 2.0, places=2)
        self.assertAlmostEqual(c['percentile']['ppk'], 2.0, places=1)

    def test_lognormal_fit_uses_the_iso_percentile_method(self):
        mu, sigma = 1.5, 0.4
        x = [math.exp(v) for v in normal_sample(5000, mu, sigma)]
        c = ls.capability(x, usl=30)
        median = math.exp(mu)
        p99865 = math.exp(mu + sigma * NormalDist().inv_cdf(0.99865))
        self.assertAlmostEqual(c['lognormal']['ppk'], (30 - median) / (p99865 - median), places=2)
        expected_ppm = (1 - NormalDist(mu, sigma).cdf(math.log(30))) * 1e6
        self.assertAlmostEqual(c['lognormal']['ppm'], expected_ppm, delta=expected_ppm * 0.05 + 1)

    def test_observed_ppm_counts_values_over_the_limit(self):
        c = ls.capability([1.0] * 998 + [60.0, 70.0], usl=50)
        self.assertEqual(c['observed_ppm'], 2000)


class StabilityTest(unittest.TestCase):
    def test_xbar_r_limits_for_subgroups_of_25(self):
        x = [float(i % 25) for i in range(250)]           # every subgroup is 0..24
        s = ls.xbar_r(x, size=25)
        self.assertEqual(len(s['means']), 10)
        self.assertAlmostEqual(s['center'], 12.0)
        self.assertAlmostEqual(s['rbar'], 24.0)
        self.assertAlmostEqual(s['ucl'], 12.0 + 0.153 * 24.0)
        self.assertAlmostEqual(s['r_ucl'], 1.541 * 24.0)
        self.assertEqual(s['out_of_control'], 0)

    def test_a_burst_is_flagged_out_of_control(self):
        x = [5.0 + (i % 5) * 0.1 for i in range(500)]
        x[300:325] = [80.0] * 25
        self.assertGreaterEqual(ls.xbar_r(x, size=25)['out_of_control'], 1)


class ProportionTest(unittest.TestCase):
    def test_wilson_interval(self):
        lo, hi = ls.wilson(95, 100)
        self.assertAlmostEqual(lo, 0.8882, places=3)
        self.assertAlmostEqual(hi, 0.9785, places=3)

    def test_two_proportions(self):
        r = ls.two_proportions(90, 100, 60, 100)
        self.assertAlmostEqual(r['z'], 4.8990, places=3)   # pooled p 0.75, se 0.06124
        self.assertLess(r['p'], 0.0001)


class MannWhitneyTest(unittest.TestCase):
    def test_separated_groups(self):
        r = ls.mann_whitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])
        self.assertEqual(r['u'], 0)
        self.assertAlmostEqual(r['p'], 0.0122, places=3)   # normal approximation, continuity corrected

    def test_identical_groups_are_not_different(self):
        r = ls.mann_whitney([1, 2, 3, 4], [1, 2, 3, 4])
        self.assertAlmostEqual(r['p'], 1.0, places=6)


class EndToEndTest(unittest.TestCase):
    def write_csv(self, folder, name, rows):
        path = os.path.join(folder, name)
        cols = ['session', 'seq', 'outcome', 'network_ms', 'gateway_ms', 'core_ms', 'total_ms',
                'sync_error_ms', 'upper_ms']
        with open(path, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        return path

    def rows(self, n, network, failed=0):
        out = []
        for i in range(n):
            if i < failed:
                out.append({'session': 1, 'seq': i + 1, 'outcome': 'not_submitted'})
                continue
            net = network + (i % 7)
            out.append({'session': 1, 'seq': i + 1, 'outcome': 'complete', 'network_ms': net,
                        'gateway_ms': 0.05, 'core_ms': 2.0, 'total_ms': net + 2.05,
                        'sync_error_ms': 2.0, 'upper_ms': net + 4.05})
        return out

    def test_two_runs_give_summary_capability_and_comparison(self):
        with tempfile.TemporaryDirectory() as d:
            a = self.write_csv(d, 'local.csv', self.rows(1000, 2, failed=50))
            b = self.write_csv(d, 'tunnel.csv', self.rows(1000, 30, failed=80))
            out = os.path.join(d, 'stats.json')
            text = io.StringIO()
            with redirect_stdout(text):
                code = ls.main([a, '--label', 'local', b, '--label', 'tunnel', '--json', out])
            with open(out) as f:
                r = json.load(f)
        self.assertEqual(code, 0)
        local, tunnel = r['runs']
        self.assertEqual(local['label'], 'local')
        self.assertEqual(local['sent'], 1000)
        self.assertEqual(local['complete'], 950)
        self.assertEqual(local['attribute']['within'], 950)        # every delivered one is under 50 ms
        self.assertAlmostEqual(local['attribute']['fraction'], 0.95)
        self.assertIn('total_ms', local['columns'])
        self.assertEqual(sum(local['columns']['total_ms']['histogram']['counts']) +
                         local['columns']['total_ms']['histogram']['over'], 950)
        self.assertTrue(local['samples'])
        self.assertLess(r['comparison']['mann_whitney']['p'], 0.0001)
        self.assertIn('local', text.getvalue())
        self.assertIn('Ppk', text.getvalue())

    def test_every_later_run_is_compared_with_the_first(self):
        with tempfile.TemporaryDirectory() as d:
            a = self.write_csv(d, 'a.csv', self.rows(500, 2))
            b = self.write_csv(d, 'b.csv', self.rows(500, 30))
            c = self.write_csv(d, 'c.csv', self.rows(500, 6, failed=100))
            out = os.path.join(d, 'stats.json')
            with redirect_stdout(io.StringIO()) as text:
                code = ls.main([a, '--label', 'base', b, '--label', 'slow', c, '--label', 'lossy', '--json', out])
            with open(out) as f:
                r = json.load(f)
        self.assertEqual(code, 0)
        self.assertEqual([x['labels'] for x in r['comparisons']], [['base', 'slow'], ['base', 'lossy']])
        self.assertEqual(r['comparison'], r['comparisons'][0])     # old single-pair key is kept
        lossy = r['comparisons'][1]
        self.assertAlmostEqual(lossy['median_difference_ms'], 4.0)
        self.assertAlmostEqual(lossy['within_estimate']['p2'], 0.8)
        self.assertIn('base vs lossy', text.getvalue())


if __name__ == '__main__':
    unittest.main()
