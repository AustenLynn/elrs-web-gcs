"""Embed a trimmed latency_stats.py JSON into the results page template.

    build_results_page.py stats.json tools/analysis/results_page.html out.html [goals.json]

The page replays 500 real commands per run and draws the Minitab-style summary,
capability table, Xbar-R chart and each run against the first. The optional goals.json
(per-run evidence for the other criteria) is shown as-is in the goal-evidence section.
Open out.html in a browser.
"""
import json
import sys

stats_path, template_path, out_path = sys.argv[1:4]
goals = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else None
r = json.load(open(stats_path))


def rnd(v, d=4):
    if isinstance(v, float):
        return round(v, d)
    if isinstance(v, dict):
        return {k: rnd(x, d) for k, x in v.items()}
    if isinstance(v, list):
        return [rnd(x, d) for x in v]
    return v


runs = []
for run in r['runs']:
    cols = {}
    for name, col in run['columns'].items():
        x = col['xbar_r']
        cols[name] = {'summary': col['summary'], 'normality': col['normality'],
                      'capability': col['capability'], 'histogram': col['histogram'],
                      'xbar': {k: x[k] for k in ('size', 'center', 'rbar', 'ucl', 'lcl', 'r_ucl', 'r_lcl',
                                                  'sigma_within', 'out_of_control')}}
        if name == 'total_ms':
            cols[name]['xbar']['means'] = x['means']
            cols[name]['xbar']['ranges'] = x['ranges']
    runs.append({'label': run['label'], 'sent': run['sent'], 'complete': run['complete'],
                 'outcomes': run['outcomes'], 'attribute': run['attribute'], 'columns': cols,
                 'samples': run['samples']})
data = rnd({'usl': r['usl_ms'], 'subgroup': r['subgroup'], 'runs': runs,
            'comparisons': r.get('comparisons', [r['comparison']] if 'comparison' in r else []), 'goals': goals})
html = open(template_path).read().replace('/*__DATA__*/null', json.dumps(data, separators=(',', ':')))
open(out_path, 'w').write(html)
print(f'wrote {out_path}: {len(html) / 1024:.0f} KB')
