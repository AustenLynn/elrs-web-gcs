#!/usr/bin/env bash
# unit.sh PLAN N: one test-first unit task. Prints the brief's Expected lines next to real output.
set -euo pipefail
plan=$1; n=$2
S=/home/maikuser/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills
W=$($S/subagent-driven-development/scripts/sdd-workspace "$plan")
out=$($S/executing-plans/scripts/task-start "$plan" "$n"); brief=$(echo "$out" | sed -n 's/^brief: //p'); base=$(echo "$out" | sed -n 's/^base: //p')
head -1 "$brief"
files=$(sed -n 's/^Create `\(.*\)`:$/\1/p' "$brief")
tests=$(echo "$files" | grep '/tests/' || true); impls=$(echo "$files" | grep -v '/tests/' || true)
python3 $W/../2026-10-05-m1-crsf-protocol/put.py "$brief" $tests >/dev/null
echo "RED expected: $(grep -m1 '^Expected: FAIL' "$brief" | cut -c1-160)"
echo "RED actual:   $( (make -s -C core test 2>&1 || true) | grep -m1 "fatal error" || echo "NO FATAL ERROR (unexpected)")"
python3 $W/../2026-10-05-m1-crsf-protocol/put.py "$brief" $impls >/dev/null
echo "GREEN expected: $(grep '^Expected: PASS' "$brief" | tail -1 | cut -c1-160)"
make -s -C core test > "$W/task-$n-green.log" 2>&1 || true
echo "GREEN actual: $(grep -c '^PASS' "$W/task-$n-green.log") PASS lines, $(grep -c '^FAIL' "$W/task-$n-green.log") FAIL lines, last: $(tail -1 "$W/task-$n-green.log")"
grep -q '^ALL TESTS PASSED' "$W/task-$n-green.log" || { echo "GREEN FAILED"; tail -20 "$W/task-$n-green.log"; exit 1; }
/home/maikuser/ProyectoTerminal/elrs-web-gcs/.superpowers/sdd/commit.sh "$brief"
$S/executing-plans/scripts/task-done "$plan" "$n" "$base" -- make -s -C core test 2>&1 | tail -1
git status --short
