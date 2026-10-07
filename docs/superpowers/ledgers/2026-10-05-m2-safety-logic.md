# SDD ledger — plan: docs/superpowers/plans/2026-10-05-m2-safety-logic.md
Spec: docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md (read; binding authority)
Pre-flight (shared interfaces):
- T1→T2: config_t channel fields (0-based ch_arm, ch_failsafe, ch_mode, stick channels) consumed by chmap_build — OK
- T2→T3: rc_outputs_t produced by chmap.h, filled by safety_* outputs — OK
- M1→T2: crsf_us_to_ch from crsf.h — OK
Ruling: execute on main (user chose "Commit on main" 2026-10-06) — cost if wrong: history on main, nothing pushed.
Task 1: complete (commits d66b5e4..334cf96, tests: make -s -C core test → ALL TESTS PASSED)
Task 2: complete (commits 334cf96..9afba86, tests: make -s -C core test → ALL TESTS PASSED)
Task 3: complete (commits 9afba86..0e5c242, tests: make -s -C core test → ALL TESTS PASSED)
Ruling: one whole-range final review (dc70c4a..HEAD) covers M1–M3 together — the three plans are one continuous C codebase and were executed in one run — cost if wrong: a reviewer sees more context than one plan.
