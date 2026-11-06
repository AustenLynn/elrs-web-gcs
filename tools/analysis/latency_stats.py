#!/usr/bin/env python3
"""Statistical summary and process capability of control latency (Minitab-style).

    latency_stats.py commands.csv [--label NAME] [commands2.csv --label NAME2]
                     [--usl 50] [--subgroup 25] [--json stats.json]

Input: the per-command CSV written by control_latency_report.py --csv (one row per sent
command, with its outcome). For each run and each segment (network, gateway, core, total,
total + clock uncertainty) it computes:

- a graphical-summary table: mean, SD, quartiles, skewness, kurtosis, 95 % intervals for the
  mean and the median, and the Anderson-Darling normality test (also on log values);
- capability against an upper limit (USL, default 50 ms): Ppk assuming normality, Ppk by the
  ISO percentile method on the data, Ppk of a fitted lognormal (ISO method), expected and
  observed PPM over the limit, and Cpk from the within-subgroup spread;
- an Xbar-R chart on consecutive subgroups (default 25 commands, 0.5 s at 50 Hz);
- the attribute view the acceptance criterion uses: share of ALL sent commands delivered
  with total + clock uncertainty <= USL, with a Wilson 95 % interval.

With two runs it also compares them: Mann-Whitney test on total latency (no normality
assumption) and a two-proportion z test on the share within the limit.

Standard library only, so it runs on the Pi. Exit 0 on success, 2 on unusable input.
"""
import argparse
import csv
import json
import math
import sys
from statistics import NormalDist

Z = NormalDist()
SEGMENTS = ('network_ms', 'gateway_ms', 'core_ms', 'total_ms', 'upper_ms')
# Xbar-R constants by subgroup size (ASTM / Montgomery tables).
XBAR_R = {5: (0.577, 0.0, 2.114, 2.326), 10: (0.308, 0.223, 1.777, 3.078),
          20: (0.180, 0.415, 1.585, 3.735), 25: (0.153, 0.459, 1.541, 3.931)}  # A2, D3, D4, d2


def percentile(sorted_x, p):
    """Percentile with the (n + 1) p rule and linear interpolation (Minitab's method)."""
    n = len(sorted_x)
    h = (n + 1) * p
    if h <= 1:
        return sorted_x[0]
    if h >= n:
        return sorted_x[-1]
    lo = int(math.floor(h))
    return sorted_x[lo - 1] + (h - lo) * (sorted_x[lo] - sorted_x[lo - 1])


def t_quantile(p, df):
    """Student t quantile, Cornish-Fisher expansion (accurate to ~1e-3 for df >= 10)."""
    z = Z.inv_cdf(p)
    return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2)


def describe(x):
    s = sorted(x)
    n = len(s)
    if n < 4:
        raise ValueError('need at least 4 values')
    mean = math.fsum(s) / n
    sd = math.sqrt(math.fsum((v - mean) ** 2 for v in s) / (n - 1))
    m3 = math.fsum(((v - mean) / sd) ** 3 for v in s) if sd else 0.0
    m4 = math.fsum(((v - mean) / sd) ** 4 for v in s) if sd else 0.0
    skew = n / ((n - 1) * (n - 2)) * m3
    kurt = (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * m4
            - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3)))
    half = t_quantile(0.975, n - 1) * sd / math.sqrt(n)
    # Nonparametric median interval from order statistics (normal approximation to the binomial).
    k = 1.959964 * math.sqrt(n) / 2
    lo_rank = max(1, int(math.floor(n / 2 - k)))
    hi_rank = min(n, int(math.ceil(n / 2 + k)) + 1)
    return {'n': n, 'mean': mean, 'sd': sd, 'se': sd / math.sqrt(n), 'mean_ci': [mean - half, mean + half],
            'min': s[0], 'q1': percentile(s, .25), 'median': percentile(s, .5), 'q3': percentile(s, .75),
            'max': s[-1], 'p90': percentile(s, .9), 'p99': percentile(s, .99),
            'median_ci': [s[lo_rank - 1], s[hi_rank - 1]], 'skewness': skew, 'kurtosis': kurt}


def anderson_darling(x):
    """Anderson-Darling test for normality with the Stephens/D'Agostino p-value."""
    s = sorted(x)
    n = len(s)
    mean = math.fsum(s) / n
    sd = math.sqrt(math.fsum((v - mean) ** 2 for v in s) / (n - 1))
    if sd == 0:
        return {'a2': float('inf'), 'a2_adj': float('inf'), 'p': 0.0}
    tiny = 1e-300
    total = 0.0
    for i in range(n):
        lower = Z.cdf((s[i] - mean) / sd)
        upper = Z.cdf(-(s[n - 1 - i] - mean) / sd)       # 1 - F, without losing the tail
        total += (2 * i + 1) * (math.log(max(lower, tiny)) + math.log(max(upper, tiny)))
    a2 = -n - total / n
    a = a2 * (1 + 0.75 / n + 2.25 / n ** 2)
    if a >= 10:
        p = 0.0   # far beyond any table; the approximation's quadratic turns back up past a = 153
    elif a >= 0.6:
        p = math.exp(1.2937 - 5.709 * a + 0.0186 * a * a)
    elif a >= 0.34:
        p = math.exp(0.9177 - 4.279 * a - 1.38 * a * a)
    elif a >= 0.2:
        p = 1 - math.exp(-8.318 + 42.796 * a - 59.938 * a * a)
    else:
        p = 1 - math.exp(-13.436 + 101.14 * a - 223.73 * a * a)
    return {'a2': a2, 'a2_adj': a, 'p': max(0.0, min(1.0, p))}


def ratio(num, den):
    """A capability index, or None when the spread is zero (the index is not defined)."""
    return num / den if den > 0 else None


def capability(x, usl, sigma_within=None):
    s = sorted(x)
    n = len(s)
    mean = math.fsum(s) / n
    sd = math.sqrt(math.fsum((v - mean) ** 2 for v in s) / (n - 1))
    out = {'usl': usl, 'observed_ppm': round(1e6 * sum(v > usl for v in s) / n, 1)}
    out['normal'] = {'ppk': ratio(usl - mean, 3 * sd),
                     'ppm': (1 - Z.cdf((usl - mean) / sd)) * 1e6 if sd else float(mean > usl) * 1e6}
    out['normal']['cpk'] = ratio(usl - mean, 3 * sigma_within) if sigma_within is not None else None
    med = percentile(s, .5)
    p99865 = percentile(s, .99865)
    out['percentile'] = {'ppk': ratio(usl - med, p99865 - med),
                         'p50': med, 'p99865': p99865}
    if s[0] > 0:
        logs = [math.log(v) for v in s]
        mu = math.fsum(logs) / n
        sigma = math.sqrt(math.fsum((v - mu) ** 2 for v in logs) / n)      # maximum likelihood
        x50 = math.exp(mu)
        x99865 = math.exp(mu + sigma * Z.inv_cdf(0.99865))
        out['lognormal'] = {'mu': mu, 'sigma': sigma, 'ppk': ratio(usl - x50, x99865 - x50),
                            'ppm': (1 - NormalDist(mu, sigma).cdf(math.log(usl))) * 1e6 if sigma else float(x50 > usl) * 1e6,
                            'fit': anderson_darling(logs)}
    return out


def xbar_r(x, size=25):
    a2, d3, d4, d2 = XBAR_R[size]
    groups = [x[i:i + size] for i in range(0, len(x) - size + 1, size)]
    means = [math.fsum(g) / size for g in groups]
    ranges = [max(g) - min(g) for g in groups]
    center = math.fsum(means) / len(means)
    rbar = math.fsum(ranges) / len(ranges)
    r = {'size': size, 'means': means, 'ranges': ranges, 'center': center, 'rbar': rbar,
         'ucl': center + a2 * rbar, 'lcl': center - a2 * rbar, 'r_ucl': d4 * rbar, 'r_lcl': d3 * rbar,
         'sigma_within': rbar / d2}
    r['out_of_control'] = (sum(m > r['ucl'] or m < r['lcl'] for m in means) +
                           sum(v > r['r_ucl'] or v < r['r_lcl'] for v in ranges))
    return r


def wilson(k, n, z=1.959964):
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [centre - half, centre + half]


def two_proportions(k1, n1, k2, n2):
    p1, p2 = k1 / n1, k2 / n2
    pooled = (k1 + k2) / (n1 + n2)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
    z = (p1 - p2) / se if se else 0.0
    return {'p1': p1, 'p2': p2, 'z': z, 'p': 2 * (1 - Z.cdf(abs(z)))}


def mann_whitney(a, b):
    """Two-sided Mann-Whitney U, normal approximation with tie and continuity correction."""
    n1, n2 = len(a), len(b)
    pooled = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    ranks_a = 0.0
    ties = 0.0
    i = 0
    N = n1 + n2
    while i < N:
        j = i
        while j + 1 < N and pooled[j + 1][0] == pooled[i][0]:
            j += 1
        rank = (i + j) / 2 + 1
        t = j - i + 1
        ties += t ** 3 - t
        ranks_a += rank * sum(1 for k in range(i, j + 1) if pooled[k][1] == 0)
        i = j + 1
    u = ranks_a - n1 * (n1 + 1) / 2
    mean = n1 * n2 / 2
    var = n1 * n2 / 12 * ((N + 1) - ties / (N * (N - 1)))
    if var <= 0:
        return {'u': u, 'z': 0.0, 'p': 1.0, 'prob_a_less': 0.5}
    diff = u - mean
    z = (diff - math.copysign(0.5, diff)) / math.sqrt(var) if diff else 0.0
    return {'u': u, 'z': z, 'p': min(1.0, 2 * (1 - Z.cdf(abs(z)))), 'prob_a_less': 1 - u / (n1 * n2)}


def histogram(x, width=0.5, top=60.0):
    bins = int(round(top / width))
    counts = [0] * bins
    over = 0
    for v in x:
        if v >= top:
            over += 1
        else:
            counts[max(0, int(v // width))] += 1
    return {'width': width, 'top': top, 'counts': counts, 'over': over}


def load(path):
    with open(path, newline='') as f:
        rows = list(csv.DictReader(f))
    if not rows or 'outcome' not in rows[0]:
        raise ValueError(f'{path}: not a control_latency_report.py --csv file')
    return rows


def analyse_run(rows, label, usl, subgroup, window=500):
    complete = [r for r in rows if r['outcome'] == 'complete']
    if len(complete) < subgroup * 4:
        raise ValueError(f'{label}: only {len(complete)} complete commands')
    columns = {}
    for col in SEGMENTS:
        x = [float(r[col]) for r in complete]
        chart = xbar_r(x, subgroup)
        columns[col] = {'summary': describe(x), 'normality': anderson_darling(x),
                        'capability': capability(x, usl, chart['sigma_within']),
                        'histogram': histogram(x), 'xbar_r': chart}
    within_upper = sum(float(r['upper_ms']) <= usl for r in complete)
    within_estimate = sum(float(r['total_ms']) <= usl for r in complete)
    outcomes = {}
    for r in rows:
        outcomes[r['outcome']] = outcomes.get(r['outcome'], 0) + 1
    start = max(0, len(rows) // 2 - window // 2)
    samples = []
    for r in rows[start:start + window]:
        item = {'seq': int(r['seq']), 'outcome': r['outcome']}
        if r['outcome'] == 'complete':
            item.update({k: round(float(r[k]), 3) for k in ('network_ms', 'gateway_ms', 'core_ms', 'total_ms', 'sync_error_ms')})
        samples.append(item)
    return {'label': label, 'sent': len(rows), 'complete': len(complete), 'outcomes': outcomes,
            'attribute': {'within': within_upper, 'fraction': within_upper / len(rows),
                          'ci': wilson(within_upper, len(rows)),
                          'within_estimate': within_estimate, 'fraction_estimate': within_estimate / len(rows),
                          'ci_estimate': wilson(within_estimate, len(rows))},
            'columns': columns, 'samples': samples}


def finite(v):
    """The report with every infinite or NaN number (an undefined statistic) as None."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [finite(x) for x in v]
    return v


def fmt(v, digits=2):
    return 'n/a' if v is None else f'{v:.{digits}f}'


def fmt_p(p):
    return '<0.005' if p < 0.005 else f'{p:.3f}'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='+', help='CSV files, each optionally followed by --label NAME')
    ap.add_argument('--usl', type=float, default=50.0)
    ap.add_argument('--subgroup', type=int, default=25, choices=sorted(XBAR_R))
    ap.add_argument('--json', dest='json_out')
    # Labels follow their file: parse "a.csv --label x b.csv --label y" by hand.
    argv = list(sys.argv[1:] if argv is None else argv)
    files, labels, rest, i = [], [], [], 0
    while i < len(argv):
        if argv[i] == '--label' and i + 1 < len(argv) and files:
            labels[-1] = argv[i + 1]
            i += 2
        elif argv[i].startswith('--'):
            rest += argv[i:i + 2]
            i += 2
        else:
            files.append(argv[i])
            labels.append(f'run{len(files)}')
            i += 1
    args = ap.parse_args(files + rest)
    try:
        runs = [analyse_run(load(f), label, args.usl, args.subgroup) for f, label in zip(files, labels)]
        report = {'usl_ms': args.usl, 'subgroup': args.subgroup, 'runs': runs}
        if len(runs) >= 2:
            # Every later run against the first one (the baseline).
            a = runs[0]
            ta = [float(r['total_ms']) for r in load(files[0]) if r['outcome'] == 'complete']
            report['comparisons'] = []
            for path, b in zip(files[1:], runs[1:]):
                tb = [float(r['total_ms']) for r in load(path) if r['outcome'] == 'complete']
                report['comparisons'].append({
                    'labels': [a['label'], b['label']],
                    'median_difference_ms': b['columns']['total_ms']['summary']['median'] - a['columns']['total_ms']['summary']['median'],
                    'mann_whitney': mann_whitney(ta, tb),
                    'within_estimate': two_proportions(a['attribute']['within_estimate'], a['sent'],
                                                       b['attribute']['within_estimate'], b['sent'])})
            report['comparison'] = report['comparisons'][0]
    except (OSError, ValueError, KeyError) as err:
        print(f'latency_stats: {err}', file=sys.stderr)
        return 2
    if args.json_out:
        with open(args.json_out, 'w') as f:
            json.dump(finite(report), f, indent=1, allow_nan=False)
    for run in runs:
        t = run['columns']['total_ms']
        s, c, a = t['summary'], t['capability'], run['attribute']
        print(f"== {run['label']}: sent {run['sent']}, complete {run['complete']} ==")
        print(f"total ms: mean {s['mean']:.2f} (95% CI {s['mean_ci'][0]:.2f}-{s['mean_ci'][1]:.2f}), SD {s['sd']:.2f}, "
              f"median {s['median']:.2f}, Q1 {s['q1']:.2f}, Q3 {s['q3']:.2f}, max {s['max']:.2f}, "
              f"skew {s['skewness']:.2f}, kurtosis {s['kurtosis']:.1f}")
        logn = c.get('lognormal', {'ppk': None, 'ppm': None, 'fit': {'a2': float('nan'), 'p': 1.0}})
        print(f"Anderson-Darling normal: A2 {t['normality']['a2']:.1f}, p {fmt_p(t['normality']['p'])}; "
              f"lognormal: A2 {logn['fit']['a2']:.1f}, p {fmt_p(logn['fit']['p'])}")
        print(f"USL {c['usl']:g} ms: Ppk normal {fmt(c['normal']['ppk'])} (Cpk {fmt(c['normal']['cpk'])}), "
              f"Ppk percentile {fmt(c['percentile']['ppk'])}, Ppk lognormal {fmt(logn['ppk'])}; "
              f"PPM observed {c['observed_ppm']:.0f}, normal {c['normal']['ppm']:.1f}, lognormal {fmt(logn['ppm'], 1)}")
        print(f"Xbar-R ({t['xbar_r']['size']}): {t['xbar_r']['out_of_control']} points out of control of "
              f"{len(t['xbar_r']['means'])} subgroups")
        print(f"Within {c['usl']:g} ms of all sent, with clock uncertainty: {a['fraction'] * 100:.2f}% "
              f"(95% CI {a['ci'][0] * 100:.2f}-{a['ci'][1] * 100:.2f}); estimate only {a['fraction_estimate'] * 100:.2f}%")
    for cmp in report.get('comparisons', []):
        print(f"== {cmp['labels'][0]} vs {cmp['labels'][1]} ==")
        print(f"median difference {cmp['median_difference_ms']:.2f} ms; Mann-Whitney z {cmp['mann_whitney']['z']:.1f}, "
              f"p {fmt_p(cmp['mann_whitney']['p'])}; within-limit z {cmp['within_estimate']['z']:.1f}, "
              f"p {fmt_p(cmp['within_estimate']['p'])}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
