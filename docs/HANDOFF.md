# Handoff: state of the project and how to continue

Written 2026-10-06 for the next person or agent working on this repository. Read this
first, then the spec (`docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md`).

## 1. The project

University terminal project (Universidad Iberoamericana, Otoño 2026, Equipo 1): a web
ground control station for an ExpressLRS drone. Browsers send joystick commands to a
Raspberry Pi 4, which turns them into CRSF frames for an ELRS TX module.

Requirements:
- failsafe in under 1 s on every link;
- local FPV video for 2 or more viewers;
- an optional internet relay (Deliverable 5, cuttable).

Final delivery: **2026-11-23**. The charter, Gantt, P-diagrams, boundary diagram and FMEA
live outside the repo, in `~/ProyectoTerminal` on the Pi.

Decisions made by the team (spec §2, D1–D5):

| # | Decision |
|---|----------|
| D1 | TX module: BetaFPV Micro 1W 2.4 GHz on its USB-C port (CP2102 → `/dev/ttyUSB0`), not the Pi's GPIO UART |
| D2 | Written from scratch; `~/ProyectoTerminal/elrs-joystick-control` (the AustenLynn fork of `kaack/elrs-joystick-control`) is used as a protocol reference only, never as code to patch |
| D3 | Real-time core in C (gcc 14 + make on the Pi) |
| D4 | Drone: BetaFPV Aquila20 HD with BetaFPV's own firmware (amended 2026-10-07; was Betaflight, kept as `fc_profile = betaflight`) |
| D5 | Two processes: `crsf-core` (C, real-time) and a Node.js gateway, joined by a Unix socket |

Proposals P1–P11 in spec §2 still need the team's confirmation. Among them: the 300 ms
command timeout, the C1 jitter target, and no automatic restart of crsf-core.

## 2. Hardware facts learned on the bench (not in the plans)

- **DIP switches on the BetaFPV Micro 1W** (from betafpv.com/products/elrs-micro-tx-module):
  - 1–2: "Update Firmware". USB-C is connected to the ESP32 UART. **This is the mode our
    USB-CRSF design needs.**
  - 3–4: "Operating Mode". The UART goes to the radio-bay pin.
  - 5–6–7: "Update Backpack".
  - Never turn all of them on.
  - The module arrived with 3–4 on, which gives zero bytes over USB. It is now set to **1–2 ON, 3–7 OFF**.
- **Power:** USB cannot power the 1 W module.
  - On USB alone the ESP32 boots and the green LED blinks, but it browns out, drops off
    USB repeatedly, and its Wi-Fi access point never comes up.
  - It needs **5–12 V on the XT30** (2S recommended). **Never 3S (12.6 V): that permanently
    destroys the power chip.**
  - This makes FMEA row (a) "module brown-out" real.
- **What USB showed with switches 1–2 on:**
  - The ESP32 boot ROM message at 115200 baud after an RTS reset pulse.
  - ELRS backpack MSP frames at 460800 baud, about once a second.
  - **No CRSF at any baud rate** (115200, 400000, 921600 or 1870000).
  - CRSF is still routed to the radio-bay pin, so the module's Wi-Fi page must be changed:
    CRSF RX = 3, TX = 1, Backpack/logging off (`docs/setup/module.md` §1). That needs XT30 power first.
- **USB serial device:**
  - Stable name `/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0`.
  - This matches `deploy/crsf-core.conf`.
  - A data-capable USB-C cable is required; the first cable was charge-only.
- **Pi temperature:**
  - It reaches 74–82 °C during the browser and video tests and throttles (`vcgencmd get_throttled` = 0x80000).
  - One video test dropped frames until the Pi cooled down.
  - **Add a heatsink or fan before the C1 jitter and C4 video measurements.**
- **Pi environment:**
  - Debian 13 arm64 with a PREEMPT kernel (not RT); gcc 14; Node 22; Python 3.13; Firefox 155.
  - Firefox runs headless for the browser tests; Chromium cannot load localhost on this Pi.
  - `sudo` needs a password (the user runs root commands themselves).
  - MediaMTX v1.21.1 is installed in `/opt/mediamtx` (done by the user, M6 Task 3).
  - `/tmp` is tmpfs, so it is wiped on reboot.

## 3. Status per milestone

All software tasks are done, reviewed and pushed (`origin/main`). What remains needs
hardware or outside resources.

| Plan | Done | Remaining (blocked on) |
|------|------|------------------------|
| M1 CRSF library and tools | **all (done 2026-10-07)** | — (module verified: ExpressLRS 3.3.0 at 921600 baud; RX 3.5.6; see `docs/setup/module.md` §2 and §4) |
| M2 safety logic | all | — |
| M3 crsf-core daemon | **all (done 2026-10-07)** | — (installed on the Pi, FIFO 80 on isolated CPU 3; bench test 15/15 PASS: `docs/procedures/m3-bench-test.md`) |
| M4 gateway and pilot page | Tasks 1–9 | **Task 10**: checklist on a PC and an Android phone (M3 is done, so this can run now). Start `gcs-gateway` again first (it is stopped during `crsf-ctl pilot` sessions). |
| M5 validation tools | Tasks 1–2 | **Tasks 3–4**: C1 and C3 campaigns. The procedure docs come from the plan, but the C3 analysis must now use `failsafe_report.py --since <campaign start, UTC>`, and `--no-fc` (the Aquila20 sends no failsafe telemetry; these options were added in review). |
| M6 video | Tasks 1–5 | **Task 6**: FPV receiver plus capture dongle, C2/C4 measurements, C1 run C. |
| M7 relay | Tasks 1–5 | **Task 6**: VPS deployment and internet tests. This task edits `docs/procedures/c3-failsafe.md`, which M5 Task 4 creates. |

Run the hardware tasks in this order: M1 T9, M3 T8, M4 T10, M5 T3–4, M6 T6, M7 T6.
**Propellers off** for every bench step.

## 4. How the work was done and how to continue it

- Each plan in `docs/superpowers/plans/` is executed task by task, test first: run the RED
  test, watch it fail as the plan's **Expected** line says, implement, run GREEN, commit.
- Commit on `main`. **Push only when the user asks.** Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FH2h7uPkhHvWtbotLYWPsQ
  ```
- After each milestone's software, a fresh reviewer (read-only) went through the whole
  range. Critical and Important findings were fixed test-first. Minors were deferred.
- **The plans show the code as written before those reviews.** The M4 plan was updated
  later; the others were not. Git history and the ledgers record every change. If you
  re-run a plan step, expect some edits not to apply (they conflict with review fixes):
  apply the same intent by hand and record a ruling.
- **Ledgers:** `docs/superpowers/ledgers/*.md` is a snapshot of each plan's ledger:
  - every completed task with its commit range and test result;
  - every **Ruling** (a decision taken on the team's behalf, with its cost if wrong);
  - every **deferred minor** review finding;
  - every deferred hardware task.

  The live copies are in `.superpowers/sdd/<plan>/progress.md` (git-ignored, on the Pi only).
- **Helper scripts** used to execute the plans are in `docs/superpowers/exec-tools/`. The
  key one is `run_task.py PLAN N [FROM [TO]]`, which runs a brief's steps in order and
  stops when an edit does not apply. They call the superpowers skill scripts under
  `~/.claude/plugins/.../skills`, so adjust those paths on another machine.
- **Plan generator (not in the repo):** `~/ProyectoTerminal/plan-wip` on the Pi holds it:
  `plangen.py`, `plans_core.py`, `plans_web.py`, `gen_plans.py`, the per-milestone
  snapshots, `replay.py` and `stage.py`. You only need it to regenerate plans.

## 5. Tests

```bash
make -C core test                     # 125 C unit tests (UBSan)
make -C core integration              # 36 tests: real binaries vs a Python fake TX module on a pty
npm --prefix relay install && npm --prefix gateway install   # first time only
npm --prefix relay test               # 11
npm --prefix gateway test             # 209 (gateway + web)
python3 -W error -m unittest discover -s tools/analysis -t tools/analysis   # 26
make -C core && npm --prefix gateway run e2e   # 8 headless-Firefox tests (handover, keyboard, layout, pilot, video), one at a time
```

Counts from 2026-10-20 (`feat/pilot-auth-handover`), run on an x86 WSL (Kali) machine, where
the video test was skipped (no MediaMTX). There the tools came from `build-essential`,
`firefox-esr` (linked as `~/.local/bin/firefox`, the name the tests start) and Node 24: Kali's
Node 22 package crashes `node --test` (`Missing internal module 'internal/deps/brace-expansion'`).

The browser tests run one at a time (`--test-concurrency=1`): run in parallel, six Firefoxes on
the Pi's 4 cores delay the page's commands enough that the arming tests time out.

The video browser test uses `/opt/mediamtx/mediamtx`, or `MEDIAMTX=<path>`. It is skipped
if MediaMTX is missing. It drops frames when the Pi is throttling, so let the Pi cool
first. The gateway's relay tests import `relay/`, so install both packages.

## 6. Open items for the team

- **Resolved 2026-10-20 (branch `feat/pilot-auth-handover`, once merged and installed): login on
  the pilot page.** Before it, the gateway was exposed through a Cloudflare *quick tunnel*
  (`~/.local/bin/cloudflared tunnel --url https://localhost:8443 --no-tls-verify`) for the
  2026-10-07 test and the 2026-10-09 flights with no login, so anyone with the URL could arm.
  - Now only signed-in pilots fly, on the local gateway and through the tunnel. Relay pilots
    (`?room=`) still fly with the room's pilot token only, not an account.
  - Pilots queue; a ready standby takes over without FAILSAFE when the pilot's commands stop
    (`ARCHITECTURE.md` §6.1, §7.4). **With a standby, letting go hands over: Desarmar is the way
    to stop.**
  - **Before deploying it, create the first admin on the Pi** (the gateway refuses to start
    without `auth.usersFile` in `/etc/gcs/gateway.json`; `deploy/gateway.json` has it):
    `sudo -u gcs node /opt/gcs/gateway/src/users-cli.js /var/lib/gcs/users.json add <name> --admin`.
    Run it as `gcs`: as root it would create a file the gateway cannot read. More pilots: `/admin`
    on the page. **Restart `gcs-gateway` after any `users-cli.js` change**: the running gateway
    keeps the accounts in memory.
  - Bench steps: `docs/procedures/m4-pilot-checklist.md` 15–17.
  - Stop a tunnel when the test ends (kill the `cloudflared` process).

- **First flights, 2026-10-09: see `docs/flight-tests/2026-10-09-first-flights.md`.**
  - The web controller feels less smooth than the physical one.
  - In Normal mode the drone came down to the ground with the motors running.
  - One in-flight `cmd_timeout` failsafe, and three arms that failed safe at once (`rf_lost`).
  - §5 of that report lists the open items. Several are team decisions: Prueba ramp, a
    failsafe that lands, the 300 ms timeout (P1), the CH7 sensitivity.

- **Resolved 2026-10-07: the drone does not run Betaflight.** The team kept the Aquila20.
  - crsf-core has `fc_profile = aquila20 | betaflight`. In `aquila20` (the default), FAILSAFE drops
    ARM over a live link, and CH7 stays at S. Design: `docs/superpowers/specs/2026-10-07-aquila20-profile-design.md`.
    Plan: `docs/superpowers/plans/2026-10-07-m8-aquila20-profile.md`. The drone itself:
    `docs/setup/aquila20.md`.
  - When the deferred hardware tasks run, adapt their Betaflight steps:
    - **M3 Task 8:** use `aquila20.md` §3 instead of `betaflight.md`.
    - **M3 bench test and M4 checklist:** the failsafe rows check "CH5 low, motors stop" instead of
      "CH7 high / Betaflight FAILSAFE".
    - **M5 Task 4 (C3):** run `failsafe_report.py --no-fc`, and video at least 3 runs per link.

- Confirm proposals P1–P11 (spec §2) and the C1 limits (p99 ≤ 250 µs, max ≤ 1 ms) with the mentor.
- Licence: the reference project is GPL-3.0 / Fair Source. Our code was written
  independently, but confirm the project's own licence (the repo has no LICENSE yet). It is public.
- Commits on `main` show the author "Raspberry Pi OS" (the Pi's global git name). Some later
  commits show "Austen Lynn". Set `git config --global user.name` if this matters.
- Deferred minor review findings: listed in each ledger as `Final: minor (deferred)`.
  None of them blocks the hardware tasks.
- Spec §9 open hardware items: the timing sign convention (M3 bench step 2), Betaflight
  value names, ELRS setting names, the capture dongle's formats, and the charter wording
  ("UART de hardware" → USB).
