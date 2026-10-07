"""run_task.py PLAN N [FROM_STEP [TO_STEP]]: execute a brief's steps in order (files, edits, runs, commit).
Prints, for each Run step, the brief's Expected line and the command's key output lines."""
import os, re, subprocess, sys
S = "/home/maikuser/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills"
plan, n = sys.argv[1], int(sys.argv[2])
lo = int(sys.argv[3]) if len(sys.argv) > 3 else 1
hi = int(sys.argv[4]) if len(sys.argv) > 4 else 99
ws = subprocess.check_output([S + "/subagent-driven-development/scripts/sdd-workspace", plan], text=True).strip()
brief = os.path.join(ws, "task-%d-brief.md" % n)
if lo == 1 or not os.path.exists(brief):
    out = subprocess.check_output([S + "/executing-plans/scripts/task-start", plan, str(n)], text=True)
    open(os.path.join(ws, "t%d.base" % n), "w").write(re.search(r"base: (\w+)", out).group(1))
lines = open(brief).read().split("\n")
steps, cur = [], None
for l in lines:
    m = re.match(r"^- \[ \] \*\*Step (\d+): (.*)\*\*$", l)
    if m: cur = [int(m.group(1)), m.group(2), []]; steps.append(cur); continue
    if cur: cur[2].append(l)
KEY = re.compile(r"^# (tests|pass|fail|skipped) |^not ok|^ok \d|Cannot find module|does not provide|Error|^(PASS|FAIL)|^Ran |^OK|^FAILED|fatal error|ALL TESTS|added \d+ package|certificate valid|note:|installed|^  error:")
SD = "/home/maikuser/ProyectoTerminal/elrs-web-gcs/.superpowers/sdd"
for num, label, body in steps:
    if not lo <= num <= hi: continue
    print("## Step %d: %s" % (num, label))
    text = "\n".join(body)
    if label == "Commit":
        print(subprocess.run([SD + "/commit.sh", brief], capture_output=True, text=True).stdout.strip()); continue
    files = re.findall(r"^(?:Create|Replace the whole file) `([^`]+)`:$", text, re.M) + re.findall(r"^Replace the whole of `([^`]+)` with:$", text, re.M)
    if files:
        tmp = os.path.join(ws, "step.md"); open(tmp, "w").write(text + "\n")
        r = subprocess.run(["python3", SD + "/2026-10-05-m1-crsf-protocol/put.py", tmp] + files, capture_output=True, text=True)
        print("  wrote:", ", ".join(files), r.stderr.strip())
    edits = sorted(set(re.findall(r"^In `([^`]+)`(?: \(change \d+ of \d+\))?, replace:$", text, re.M)))
    if edits:
        tmp = os.path.join(ws, "step.md"); open(tmp, "w").write(text + "\n")
        r = subprocess.run(["python3", SD + "/edit.py", tmp] + edits, capture_output=True, text=True)
        print("  " + (r.stdout + r.stderr).strip().replace("\n", "\n  "))
        if r.returncode != 0:
            sys.exit("STOPPED: edit did not apply; rule on it before continuing")
    m = re.search(r"^Run: `(.+)`$", text, re.M) or re.search(r"^Run:\n\n```bash\n(.*?)\n```", text, re.M | re.S)
    if m:
        cmd = m.group(1)
        exp = re.search(r"^Expected: (.*)$", text, re.M)
        print("  $", cmd)
        print("  EXPECTED:", exp.group(1) if exp else "-")
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=600)
        out = r.stdout + r.stderr
        open(os.path.join(ws, "task-%d-step-%d.log" % (n, num)), "w").write(out)
        keep = [l for l in out.splitlines() if KEY.search(l) and not re.match(r"^ok \d", l)]
        print("  ACTUAL (exit %d):" % r.returncode)
        for l in keep[:14]: print("   |", l[:220])
    elif not files and not edits:
        print("  (manual step)\n  " + text.strip()[:600].replace("\n", "\n  "))
