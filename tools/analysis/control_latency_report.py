#!/usr/bin/env python3
"""Three-segment browser-to-serial latency; no radio reception claim.

control_latency_report.py sent.json gateway.jsonl core.jsonl [--json report.json] [--csv commands.csv]
Missing commands remain in the denominator. Exit 0: software criterion met, 1: not met,
2: unusable input. Network timing uses clock offset estimates, with RTT/2 uncertainty.
Damaged log lines (NUL bytes or a half-written line left by a power cut) are skipped and
counted; the records they held can only turn commands into failures, never into successes.
"""
import argparse
from collections import Counter
import csv
import json
import math
from pathlib import Path
import sys


def number(value):
    if isinstance(value, bool):
        raise ValueError('boolean timestamp')
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('non-finite timestamp')
    return value


def key(row):
    session, seq = row['session'], row['seq']
    if any(type(v) is not int or not 1 <= v <= 0xffffffff for v in (session, seq)):
        raise ValueError('invalid session/sequence')
    return session, seq


def summary(values):
    if not values:
        return None
    values = sorted(values)
    pct = lambda p: values[max(0, math.ceil(p * len(values)) - 1)]
    return {'n': len(values), 'p50': pct(.5), 'p90': pct(.9), 'p99': pct(.99), 'max': values[-1]}


def analyse(manifest, gateway, core, min_commands=10000, limit_ms=50, fraction=.9, max_sync_age_ms=20000):
    if manifest.get('version') != 1 or not isinstance(manifest.get('commands'), list):
        raise ValueError('not a version 1 browser sent manifest')
    commands = manifest['commands']
    if not commands:
        raise ValueError('no sent commands')
    problems = []
    if manifest.get('overflow') is not False or manifest.get('sent') != len(commands):
        problems.append('browser capture overflow or inconsistent sent count')
    sent = {}
    for row in commands:
        k = key(row)
        number(row['ts'])
        if k in sent:
            problems.append('duplicate browser command')
        sent[k] = row

    def index(records, event):
        out = {}
        for r in records:
            if r.get('ev') != event:
                continue
            k = key(r)
            if k not in sent:
                continue
            if k in out:
                problems.append('duplicate ' + event)
            out[k] = r
        return out

    gw = index(gateway, 'control')
    receipts = index(core, 'control_received')
    writes = index(core, 'control_serial')
    segments = {s: [] for s in ('network', 'gateway', 'core', 'total')}
    outcomes, paths = Counter(), Counter()
    details = []
    within_estimate = within_upper = 0
    for k, command in sent.items():
        detail = {'session': k[0], 'seq': k[1]}
        g, receipt, write = gw.get(k), receipts.get(k), writes.get(k)
        status = 'missing_gateway'
        if g:
            paths[g.get('via', 'unknown')] += 1
            status = g.get('outcome', 'unknown_outcome')
            if number(g['browser_ts_ms']) != number(command['ts']):
                problems.append('browser/gateway timestamp mismatch')
                status = 'timestamp_mismatch'
            elif status == 'forwarded':
                status = 'missing_core_receipt' if not receipt else 'not_submitted'
                if receipt and write:
                    try:
                        recv = int(g['recv_ns'])
                        forward = int(g['forward_ns'])
                        received = int(receipt['t_ns'])
                        end = int(write['t_ns'])
                        if not (recv <= forward <= received <= end):
                            raise ValueError('non-monotonic trace')
                        if int(write['received_ns']) != received or write['bytes'] != 26:
                            raise ValueError('inconsistent serial completion')
                        network = number(g['network_ms'])
                        uncertainty = number(g['sync_error_ms'])
                        sync_age = number(g['sync_age_ms'])
                        if network < 0 or uncertainty < 0:
                            raise ValueError('negative network delay or uncertainty')
                        if not 0 <= sync_age < max_sync_age_ms:
                            status = 'expired_sync'
                        else:
                            gateway_ms = (forward - recv) / 1e6
                            core_ms = (end - forward) / 1e6
                            total = network + gateway_ms + core_ms
                            upper = total + uncertainty
                            status = 'complete'
                            for name, value in zip(segments, (network, gateway_ms, core_ms, total)):
                                segments[name].append(value)
                            within_estimate += total <= limit_ms
                            within_upper += upper <= limit_ms
                            detail.update(network_ms=network, gateway_ms=gateway_ms, core_ms=core_ms,
                                          total_ms=total, sync_error_ms=uncertainty, upper_ms=upper)
                    except (KeyError, TypeError, ValueError, OverflowError):
                        status = 'unsynchronised' if g.get('network_ms') is None else 'invalid_timing'
        detail['outcome'] = status
        outcomes[status] += 1
        details.append(detail)
    n = len(commands)
    if n < min_commands:
        problems.append(f'need at least {min_commands} sent commands; have {n}')
    if paths.get('local', 0) != len(gw):
        problems.append('capture includes tunnel/relay/unknown routing; local evidence required')
    if within_upper / n < fraction:
        problems.append(f'less than {fraction:.0%} of sent commands within {limit_ms:g} ms including sync uncertainty')
    return {'endpoint': 'serial-submission (not module reception)', 'sent': n,
            'complete': outcomes['complete'], 'outcomes': dict(outcomes), 'paths': dict(paths),
            'segments': {name: summary(v) for name, v in segments.items()},
            'within_estimate': within_estimate, 'within_upper': within_upper,
            'estimated_pct': within_estimate * 100 / n, 'conservative_pct': within_upper * 100 / n,
            'limit_ms': limit_ms, 'problems': sorted(set(problems)), 'pass': not problems, 'commands': details}


def read_jsonl(path):
    """Records of a JSON-lines log, and how many damaged lines were skipped.

    A power cut leaves NUL bytes where the file system had reserved space, and can cut the
    last line short. NUL bytes are removed before parsing; a line of NUL bytes only, or one
    that is still not a JSON object, is skipped and counted. Blank lines are ignored.
    """
    records, damaged = [], 0
    with open(path, errors='replace') as f:
        for line in f:
            cleaned = line.replace('\x00', '').strip()
            if not cleaned:
                damaged += '\x00' in line   # a line of NUL bytes is what a power cut leaves
                continue
            line = cleaned
            try:
                record = json.loads(line)
            except ValueError:
                damaged += 1
                continue
            if isinstance(record, dict):
                records.append(record)
            else:
                damaged += 1
    return records, damaged


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('sent')
    ap.add_argument('gateway')
    ap.add_argument('core')
    ap.add_argument('--json', dest='json_out')
    ap.add_argument('--csv', dest='csv_out')
    args = ap.parse_args(argv)
    try:
        gateway, gateway_damaged = read_jsonl(args.gateway)
        core, core_damaged = read_jsonl(args.core)
        r = analyse(json.loads(Path(args.sent).read_text()), gateway, core)
        r['damaged_lines'] = {'gateway': gateway_damaged, 'core': core_damaged}
        if args.json_out:
            Path(args.json_out).write_text(json.dumps(r, indent=2, allow_nan=False) + '\n')
        if args.csv_out:
            columns = ['session', 'seq', 'outcome', 'network_ms', 'gateway_ms', 'core_ms',
                       'total_ms', 'sync_error_ms', 'upper_ms']
            with open(args.csv_out, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=columns)
                writer.writeheader()
                writer.writerows(r['commands'])
    except (OSError, ValueError, KeyError, TypeError) as err:
        print(f'control_latency_report: {err}', file=sys.stderr)
        return 2
    print(f"Endpoint: {r['endpoint']}")
    print(f"Sent {r['sent']}, complete {r['complete']}; paths {r['paths']}")
    print('%-12s %9s %9s %9s %9s (ms)' % ('segment', 'p50', 'p90', 'p99', 'max'))
    for name, s in r['segments'].items():
        if s:
            print('%-12s %9.3f %9.3f %9.3f %9.3f' % (name, s['p50'], s['p90'], s['p99'], s['max']))
    print(f"Within 50 ms: estimated {r['estimated_pct']:.2f}%, including RTT/2 uncertainty {r['conservative_pct']:.2f}%")
    print(f"Outcomes: {r['outcomes']}")
    damaged = r['damaged_lines']
    if damaged['gateway'] or damaged['core']:
        print(f"Skipped damaged log lines: gateway {damaged['gateway']}, core {damaged['core']}")
    print('RESULT: ' + ('PASS (software endpoint and clock-sync assumptions)' if r['pass'] else 'NOT VALIDATED'))
    for problem in r['problems']:
        print('- ' + problem)
    return 0 if r['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
