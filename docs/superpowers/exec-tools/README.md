# Plan execution helpers

These scripts were used to execute the plans in `docs/superpowers/plans/` with the superpowers
`executing-plans` skill. They expect to live in the plan workspaces, so copy them back first:

```bash
mkdir -p .superpowers/sdd/2026-10-05-m1-crsf-protocol
cp docs/superpowers/exec-tools/{run_task.py,edit.py,commit.sh,unit.sh} .superpowers/sdd/
cp docs/superpowers/exec-tools/put.py .superpowers/sdd/2026-10-05-m1-crsf-protocol/
```

| Script | What it does |
|--------|--------------|
| `run_task.py PLAN N [FROM [TO]]` | Runs task N's brief step by step: writes files (`put.py`), applies find/replace edits (`edit.py`), runs each `Run:` command and prints the brief's **Expected** line next to the key lines of the real output, and commits (`commit.sh`). **It stops when an edit does not apply**; rule on it, apply the change by hand, then continue with `FROM`. |
| `put.py BRIEF PATH...` | Writes files exactly as a brief gives them (Create / Replace blocks). |
| `edit.py BRIEF PATH...` | Applies a brief's find/replace blocks; each must match exactly once. |
| `commit.sh BRIEF` | Runs the brief's `git add` / `git commit` with the session trailer lines. **Update the `Claude-Session` line to your own session.** |
| `unit.sh PLAN N` | Older one-shot runner for the C unit-test tasks of M1–M3. |

`run_task.py` and `unit.sh` call the skill's `task-start` / `sdd-workspace` scripts. Their
path is hard-coded (`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills`);
change `S` if your installed version differs. After each task, record it with the skill's
`task-done` script. That script aborts on a test command that prints nothing, so give it one
that prints something.
