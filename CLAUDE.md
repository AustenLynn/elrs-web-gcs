# elrs-web-gcs

Web ground control station for an ExpressLRS drone. A C real-time core (`core/`), a Node.js
gateway (`gateway/`), a pilot web page (`web/`), an internet relay (`relay/`), analysis tools
(`tools/`) and deployment files (`deploy/`) for a Raspberry Pi 4.

**Start with `docs/HANDOFF.md`**: status, hardware facts learned on the bench, what is
blocked on hardware, how to run the tests, and how the plans were executed. Then read the spec
(`docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md`) and the plans
(`docs/superpowers/plans/`). Every decision taken while executing a plan is a `Ruling:` line
in `docs/superpowers/ledgers/`.

Rules for working here:
- Test first: watch the test fail for the expected reason, then make it pass. Run every
  suite (see `docs/HANDOFF.md` §5) before calling something done.
- Commit on `main`; **push only when the user asks**. End commit messages with the
  `Co-Authored-By` / `Claude-Session` trailer lines.
- **Propellers off** for every hardware step. Never power the TX module without its antenna.
  Never feed its XT30 more than 12 V (no 3S).
- `crsf-core` decides what the aircraft does. The gateway only forwards, filters and reports.
  Keep every safety rule in the core.
- The Pi throttles when hot: avoid repeated browser/video test runs, and check
  `vcgencmd measure_temp` before timing-sensitive measurements.
- `sudo` needs the user's password: ask them to run root commands (`! sudo …`).
