# Hold-then-Land Failsafe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the active pilot's commands stop in flight, the drone holds still for `hold_ms` and
then lands itself, instead of stopping its motors. During the hold the next pilot in the queue
chooses «Tomar el control» or «Aterrizar», and the main pilot keeps flying if their commands come
back. This covers phones on the local Wi-Fi **and** phones over the Cloudflare tunnel, and the gateway
logs every pilot connection so the next stall can be traced.

**Architecture:**
- **crsf-core** owns every decision. It gets two new states, HOLD and LANDING, between ARMED and
  FAILSAFE. It also gets two new IPC messages, `TAKE` and `LAND`, accepted only from the registered
  standby session. It reports `hold`, `resumed`, `taken` and `landing`, which replace `handover`.
- **The gateway** registers the queue head as the standby (no more «Listo»). It forwards `take` and
  `land` only from the queue head's page, and moves the seat only when the core reports `taken`. It
  writes a JSON-lines connection log (join, leave, seat, command gaps, stale drops, hold events),
  tagging each pilot with how they connected: `local`, `tunnel` or `relay`.
- **The page** shows the countdown banner over the video. It seeds a taker's inputs from the outputs
  the core reports in STATUS, so nothing jumps.

**Tech Stack:** C (gnu11, gcc 14, make), Node 22 (`node --test`, `ws` 8.22.0), plain ES modules,
Python 3.13 stdlib (integration fake TX module), headless Firefox (WebDriver BiDi e2e).

**Spec:** `docs/superpowers/specs/2026-10-21-hold-then-land-failsafe-design.md`. It amends
`docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` and
`docs/superpowers/specs/2026-10-20-pilot-auth-handover-design.md`; read all three.

## Global Constraints

- Work in `~/ProyectoTerminal/elrs-web-gcs` on branch `feat/hold-then-land`. Push and open a PR only
  when the user asks; the user says when to merge.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test first: watch each test fail for the expected reason before making it pass. Run every suite
  (`docs/HANDOFF.md` §5) before calling a task done.
- `crsf-core` decides what the aircraft does. The gateway only forwards, filters and reports. The page
  only shows (CLAUDE.md; spec anti-goal "A safety decision made in the gateway or the page").
- `hold_ms` defaults to **0 (off)** in the code. `hold_throttle` and `land_ms` have **no defaults** and
  are required when `hold_ms` > 0 (spec §4.2). `deploy/crsf-core.conf` keeps `hold_ms = 0` until the
  team signs off §8.
- Ranges: `hold_ms` 0 or 1000–10000; `land_ms` 1000–30000; `hold_throttle` 0–1000 (spec §4.2).
- Instant paths stay instant from HOLD and LANDING: Desarmar, manual FAILSAFE, `gateway_lost`,
  `rf_lost`, unexpected SESSION (spec §4.1).
- Everything the pilot reads is Spanish. Code, comments and logs are English. Exact copy: the banner
  says `«nombre» perdió la conexión · aterriza en N s`, with buttons «Tomar el control» and «Aterrizar»;
  during LANDING it says `Aterrizando…`. The state pill says `ESPERA · SIN PILOTO` / `ATERRIZANDO`. The
  queue-head text is `Estás en espera. Si «nombre» pierde la conexión, podrás tomar el control o
  aterrizar.` The main pilot sees the toast `Conexión recuperada` (spec §4.5).
- The connection log never records IP addresses or passwords: names, path (`local`/`tunnel`/`relay`),
  times and durations only.
- **Propellers off** for every bench step. The Pi throttles when hot: run the browser e2e once per
  change, and check `vcgencmd measure_temp` first.

## Decisions this plan takes (spec §6 "left to the builder")

| # | Decision |
|---|---|
| R1 | The core reports **`taken` when it accepts TAKE** (the session switch), not at the new pilot's first command. The hub has to seat the new pilot before their commands can reach the core, and seats only on a core event. The first command's arrival is still logged as the state change HOLD→ARMED (or LANDING→ARMED). |
| R2 | STATUS grows from 80 to **96 bytes**: at offset 80 `u32 stage_left_ms` (0 outside HOLD/LANDING), then the outputs on the air: `i16 roll, i16 pitch, i16 yaw, u16 throttle, u8 mode, u8 speed, u8 turtle, u8 reserved`. The taker's page seeds from these outputs (spec §4.3 "takeover sticks"). |
| R3 | IPC: `TAKE = 0x09`, `LAND = 0x0A` (u32 session, like ARM). EVENT kinds: 3 is retired (was handover). `4 hold`, `5 resumed`, `6 taken`, `7 landing` (detail = the reason that started the hold). `8 take_refused`, `9 land_refused` (detail = refuse_t). New refusals: `REFUSE_NOT_STANDBY`, `REFUSE_NOT_IN_HOLD`. |
| R4 | State wire values: `SAFETY_HOLD = 3`, `SAFETY_LANDING = 4` (appended; 0–2 unchanged). |
| R5 | A `pilot_lost` for the active session during HOLD or LANDING ends any chance to resume and marks the seat as lost: when LANDING ends, the core clears the session (spec: "session cleared after a pilot_lost landing"). A `pilot_lost` for a taker who has not sent yet works the same way: the countdown runs on. |
| R6 | Gateway connection log: path from the `Cf-Connecting-Ip` header (present = `tunnel`), relay clients = `relay`, else `local`. A command gap is logged when the active pilot's valid commands arrive more than **250 ms** apart. |
| R7 | Test values (never flight values): integration `hold_ms = 1000, land_ms = 1000, hold_throttle = 450`; browser e2e `hold_ms = 3000, land_ms = 1000, hold_throttle = 450`. |

## Review Focus

1. **A phone stall over the tunnel, then the commands come back** (the 2026-10-22 crash): the drone
   must hold at `hold_throttle` with ARM high and resume with no ARM-low frame. Pinned by Task 4,
   `test_phone_stall_then_resume_never_drops_arm`, and Task 5, `late bursts over the tunnel are dropped as stale and logged`.
2. **The taker's page closes before its first command:** the countdown continues and the drone lands.
   It must not hang in HOLD with a dead session. Pinned by Task 2,
   `test_taker_lost_before_first_command_lands_on_time`.
3. **A second loss right after a take:** it starts a new HOLD with a fresh `hold_ms`, not an instant
   FAILSAFE. Pinned by Task 2, `test_second_loss_after_take_starts_a_new_hold`.
4. **`take` or `land` from someone who isn't the queue head** (another queued pilot, a spectator, the
   old pilot): refused by the gateway and by the core. Pinned by Task 5,
   `take and land are refused from anyone but the queue head`, and Task 2, `test_take_only_from_standby`.
5. **The core restarts during a HOLD** (gateway reconnects): there must be no stuck banner and no take
   against a forgotten session. The core starts DISARMED and the page follows STATUS. Pinned by Task 5,
   `core coming back during a hold clears the hold banner state`.

---

## File Structure

| File | Change |
|---|---|
| `core/src/config.[ch]`, `deploy/crsf-core.conf` | `hold_ms`, `hold_throttle`, `land_ms` |
| `core/src/safety.[ch]` | HOLD/LANDING; TAKE/LAND; hold reports; handover code removed |
| `core/src/ipc_proto.[ch]` | TAKE/LAND, STATUS 96 bytes, new event kinds |
| `core/src/mailbox.h`, `ipcserver.c`, `rtloop.c`, `evlog.c`, `core/tools/crsf-ctl.c` | wire the above; stick log in flight states |
| `core/tests/test_{config,safety,ipc_proto,evlog}.c`, `core/tests/integration/*` | tests |
| `gateway/src/ipc.js`, `hub.js` | new messages, queue-head standby, follow `taken` |
| `gateway/src/connlog.js` (new), `server.js`, `relayClient.js`, `config.js`, `deploy/gateway.json`, `deploy/gcs-gateway.service` | connection log |
| `web/js/view.js`, `web/js/app.js`, `web/index.html`, `web/css/*` | banner, labels, take/land; «Listo» removed |
| `gateway/e2e/hold.e2e.js` (new; replaces `handover.e2e.js`) | browser e2e |
| `docs/...` | spec amendments, HANDOFF, ARCHITECTURE, M4 checklist, bench procedure, ledger |

---

### Task 1: Hold settings in crsf-core's config

**Files:**
- Modify: `core/src/config.h`, `core/src/config.c`, `deploy/crsf-core.conf`
- Test: `core/tests/test_config.c`

**Interfaces:**
- Produces: `config_t` fields `int hold_ms` (default 0), `int hold_throttle` (default -1 = unset),
  `int land_ms` (default -1 = unset). The file keys use the same names.

- [ ] **Step 1: Write the failing tests** in `core/tests/test_config.c` (and register them in `main`):

```c
static void test_hold_is_off_by_default(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(c.hold_ms, 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);   /* off: nothing else required */
}

static void test_hold_needs_throttle_and_land_time(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "hold_ms", "5000", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK(strstr(err, "hold_throttle") != NULL);
    CHECK_EQ_INT(config_set(&c, "hold_throttle", "450", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK(strstr(err, "land_ms") != NULL);
    CHECK_EQ_INT(config_set(&c, "land_ms", "6000", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
}

static void test_hold_ranges(void)
{
    config_t c;
    config_defaults(&c);
    c.hold_throttle = 450;
    c.land_ms = 6000;
    c.hold_ms = 999;   CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    c.hold_ms = 10001; CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    c.hold_ms = 1000;  CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    c.land_ms = 999;   CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    c.land_ms = 30001; CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    c.land_ms = 6000;
    c.hold_throttle = 1001; CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `make -C core test`
Expected: compile error, `'config_t' has no member named 'hold_ms'`.

- [ ] **Step 3: Implement.** Add the three fields to `config_t`, each with a one-line comment. Set the
  defaults in `config_defaults()` and add the keys to the integer-key table in `config.c`. Add these
  checks to `config_validate()`, each with a `fail()` message that names the key:
  - `hold_ms`: 0 or 1000..10000;
  - when `hold_ms > 0`: `hold_throttle` must be 0..1000 (message: `hold_throttle is required when
    hold_ms > 0 (measure the hover throttle first)`), and `land_ms` must be 1000..30000.

  In `deploy/crsf-core.conf`, below `cmd_timeout_ms`, add:

```
# Two-stage failsafe (docs/superpowers/specs/2026-10-21-hold-then-land-failsafe-design.md).
# 0 = off: commands lost in flight -> FAILSAFE at once. Do NOT enable before the team's §8
# sign-off and a measured hover throttle (hold_throttle, 0-1000) and landing time (land_ms).
hold_ms = 0
# hold_throttle =
# land_ms =
```

- [ ] **Step 4: Run and pass**

Run: `make -C core test`
Expected: all unit tests pass.

- [ ] **Step 5: Commit** `feat(core): hold_ms, hold_throttle and land_ms settings`

---

### Task 2: HOLD and LANDING in the safety state machine

**Files:**
- Modify: `core/src/safety.h`, `core/src/safety.c`
- Test: `core/tests/test_safety.c`

**Interfaces:**
- Produces (in `safety.h`):
  - `SAFETY_HOLD = 3`, `SAFETY_LANDING = 4` in `safety_state_t`; names `"HOLD"`, `"LANDING"`.
  - `REFUSE_NOT_STANDBY`, `REFUSE_NOT_IN_HOLD` appended to `refuse_t`; names `"not_standby"`,
    `"not_in_hold"`.
  - `typedef enum { HOLD_EV_HOLD = 1, HOLD_EV_RESUMED, HOLD_EV_TAKEN, HOLD_EV_LANDING } hold_ev_t;`
  - `void safety_set_hold(safety_t *s, int64_t hold_ns, int64_t land_ns, uint16_t hold_throttle);` (hold_ns 0 = off)
  - `refuse_t safety_take(safety_t *s, uint32_t session, int64_t now);`
  - `refuse_t safety_land(safety_t *s, uint32_t session, int64_t now);`
  - `bool safety_take_report(safety_t *s, hold_ev_t *ev, fs_reason_t *reason, uint32_t *session);`
    pops the oldest pending report (FIFO of 4; on overflow the newest is dropped).
  - `uint32_t safety_stage_left_ms(const safety_t *s, int64_t now);` (0 outside HOLD/LANDING)
  - `const char *safety_hold_ev_name(hold_ev_t e);` → `"hold"`, `"resumed"`, `"taken"`, `"landing"`.
- Removed: `try_handover`, `handover_pending`, `handover_to`, `handover_reason`,
  `safety_take_handover()`. `standby` and `safety_set_standby()` stay (the standby is now the queue
  head; it is only used by TAKE and LAND).

- [ ] **Step 1: Write the failing tests.** Delete the handover tests (`test_timeout_with_standby_hands_over_and_keeps_flying`
  through `test_session_start_or_gateway_lost_drops_the_handover_report`). Add a helper and these tests.
  Use `H` = 5000 ms, `L` = 6000 ms and `HT` = 450.

```c
#define HOLD (5000 * MS)
#define LAND (6000 * MS)
#define HT 450

/* Session 7 armed at t=0 flying at throttle 600, hold enabled, standby 9. */
static void flying(safety_t *s)
{
    armed(s);
    safety_set_hold(s, HOLD, LAND, HT);
    stick_cmd_t c = { .roll = 100, .throttle = 600, .mode = 2, .speed = 1, .turtle = false };
    CHECK(safety_control(s, 7, 2, &c, 0));
    safety_set_standby(s, 9);
}
```

  Tests (name: what it asserts):
  - `test_timeout_enters_hold_with_hold_outputs`: at `TIMEOUT + 1` → `SAFETY_HOLD`; `out.arm`, roll/pitch/yaw 0, `out.throttle == HT`, `out.mode == 0`, `out.speed == 1` (kept), `!out.turtle`, `!out.failsafe`; report `HOLD_EV_HOLD`, reason `FS_CMD_TIMEOUT`, session 7.
  - `test_hold_off_still_fails_safe_at_once`: `armed()` with no `safety_set_hold` → FAILSAFE `cmd_timeout` at `TIMEOUT + 1`, no report.
  - `test_pilot_lost_enters_hold`: `safety_pilot_lost(7)` → HOLD, reason `FS_PILOT_LOST`; then a command from 7 is refused (`safety_control` returns false).
  - `test_low_throttle_skips_hold_and_lands`: last throttle 50 (= `throttle_arm_max`), timeout → `SAFETY_LANDING`, `out.throttle == 0`, `out.arm`; report `HOLD_EV_LANDING`.
  - `test_resume_by_the_same_session`: HOLD from timeout; `safety_control(7, 3, {throttle 610}, t)` → true, `SAFETY_ARMED`, `out.throttle == 610`; report `HOLD_EV_RESUMED`.
  - `test_no_resume_during_landing`: HOLD → `HOLD + TIMEOUT + 1` → LANDING; a command from 7 leaves LANDING and `out.throttle == 0`.
  - `test_hold_expires_into_landing_then_failsafe`: LANDING at `TIMEOUT + HOLD`; FAILSAFE at `TIMEOUT + HOLD + LAND` with `fs_reason == FS_CMD_TIMEOUT`, ARM low on the air (via `out.failsafe`); `s.session == 7` (kept after a cmd_timeout landing).
  - `test_pilot_lost_landing_clears_the_session`: same path from `pilot_lost` → after FAILSAFE `s.session == 0`, reason `FS_PILOT_LOST`.
  - `test_take_only_from_standby`: in HOLD, `safety_take(s, 8, t)` → `REFUSE_NOT_STANDBY`; in ARMED, `safety_take(s, 9, t)` → `REFUSE_NOT_IN_HOLD`.
  - `test_take_switches_session_and_stays_hold_until_first_command`: `safety_take(9)` → `REFUSE_NONE`, `s.session == 9`, `s.standby == 0`, still HOLD with hold outputs; report `HOLD_EV_TAKEN` session 9; a command from 7 is refused; `safety_control(9, 1, {throttle 455})` → ARMED, `out.throttle == 455`.
  - `test_take_during_landing`: LANDING, `safety_take(9)` accepted; first command from 9 → ARMED.
  - `test_take_countdown_keeps_running`: take at `TIMEOUT + 100 ms`, no command → LANDING at `TIMEOUT + HOLD`.
  - `test_taker_lost_before_first_command_lands_on_time`: take, then `safety_pilot_lost(9)` → still HOLD; LANDING at `TIMEOUT + HOLD`; FAILSAFE after `LAND`; `s.session == 0`.
  - `test_second_loss_after_take_starts_a_new_hold`: take, command from 9 at t1, no more → HOLD again at `t1 + TIMEOUT + 1`, `safety_stage_left_ms == 5000` right after entering.
  - `test_land_only_from_standby_in_hold`: `safety_land(8)` → `REFUSE_NOT_STANDBY`; `safety_land(9)` in HOLD → LANDING (report `HOLD_EV_LANDING`); `safety_land(9)` again in LANDING → `REFUSE_NOT_IN_HOLD`.
  - `test_instant_paths_from_hold_and_landing`: from HOLD and from LANDING each: `safety_disarm(7)` → DISARMED, `!out.arm`; `safety_manual_failsafe(7)` → FAILSAFE `manual`; `safety_gateway_lost` → FAILSAFE `gateway_lost`; `safety_session_start(5)` → FAILSAFE `session_changed`; rf timeout set and no link report for 1000 ms → FAILSAFE `rf_lost`.
  - `test_stage_left_counts_down`: 5000 at HOLD entry, 4000 one second later, 6000 at LANDING entry, 0 when ARMED or FAILSAFE.
  - `test_arm_and_ack_unaffected`: `safety_arm` in HOLD → `REFUSE_NOT_DISARMED`; `safety_ack` in HOLD → `REFUSE_NOT_IN_FAILSAFE`.

- [ ] **Step 2: Run them and watch them fail**

Run: `make -C core test`
Expected: compile errors for `safety_set_hold`, `SAFETY_HOLD`, `safety_take`.

- [ ] **Step 3: Implement in `safety.c`.** New `safety_t` fields: `hold_ns`, `land_ns`,
  `hold_throttle`, `stage_end_ns`, `hold_reason`, `resume_session` (0 = no resume possible),
  `seat_lost`, `take_pending`, and the report FIFO. Rules beyond the tests:
  - A helper `in_flight(s)` (ARMED, HOLD or LANDING) replaces `state == SAFETY_ARMED` in
    `safety_session_start`, `safety_gateway_lost`, `safety_disarm` and the rf check in `safety_tick`.
    `enter_failsafe` clears every hold field.
  - `safety_control` applies the sticks only when the state is DISARMED or ARMED. In HOLD it resumes
    (same session, `resume_session`) or completes a take (`take_pending`). In LANDING it completes a
    take only. Otherwise it stores the command without applying it.
  - Entering HOLD sets the hold outputs and `stage_end_ns = now + hold_ns`. Entering LANDING sets
    throttle 0 (other outputs as in HOLD) and `stage_end_ns = now + land_ns`. Both queue a report.
  - `safety_tick`, in order: rf check (instant, any flight state) → ARMED and not fresh → HOLD (or
    LANDING if `cmd.throttle <= throttle_arm_max`) → HOLD expired → LANDING → LANDING expired →
    `enter_failsafe(hold_reason)`, and if `seat_lost`, clear session and `have_cmd`.
  - With `hold_ns == 0` nothing changes: cmd_timeout and pilot_lost fail safe at once.
  - Update the header comment block (the "Rules" list) to describe HOLD/LANDING instead of the handover.

- [ ] **Step 4: Run and pass**

Run: `make -C core test`
Expected: all unit tests pass. (Integration fails to build until Task 4; that's expected.)

- [ ] **Step 5: Commit** `feat(core): HOLD and LANDING replace the automatic handover`

---

### Task 3: IPC protocol: TAKE, LAND, the longer STATUS and the new events

**Files:**
- Modify: `core/src/ipc_proto.h`, `core/src/ipc_proto.c`, `core/tests/test_ipc_proto.c`

**Interfaces:**
- Consumes: Task 2's state and refusal values.
- Produces: `IPC_TAKE 0x09`, `IPC_LAND 0x0A` (decoded by `ipc_decode_session_msg`);
  `IPC_EVENT_HOLD 4`, `IPC_EVENT_RESUMED 5`, `IPC_EVENT_TAKEN 6`, `IPC_EVENT_LANDING 7`,
  `IPC_EVENT_TAKE_REFUSED 8`, `IPC_EVENT_LAND_REFUSED 9`; `IPC_EVENT_HANDOVER` removed, with a comment
  `/* 3: retired (handover) */`. `IPC_STATUS_LEN 96`; `ipc_status_t` gains, after `channels`:
  `uint32_t stage_left_ms; int16_t out_roll, out_pitch, out_yaw; uint16_t out_throttle; uint8_t out_mode, out_speed, out_turtle;`
  encoded in that order at payload offsets 80–94, with byte 95 = 0.

- [ ] **Step 1: Write the failing test.** In `test_status_round_trip_and_layout`, give
  `sample_status()` `stage_left_ms = 4321`, `out_roll = -250`, `out_throttle = 450`, `out_mode = 0`,
  `out_speed = 2`, `out_turtle = 0`, and assert `buf[3 + 80] == 0xE1` (4321 = 0x10E1 LE), the
  `out_throttle` bytes at `3 + 90` (`0xC2, 0x01`), and `buf[3 + 95] == 0`. Add
  `test_take_and_land_decode_like_session_messages` (encode `IPC_TAKE`, 9 with
  `ipc_encode_session_msg`, decode, session == 9).

- [ ] **Step 2: Run and fail**

Run: `make -C core test`
Expected: compile error on `stage_left_ms`.

- [ ] **Step 3: Implement** the defines, the struct fields and the encoder/decoder in `ipc_proto.c`.
  Update the header comment of `IPC_STATUS` and the message table at the top of `ipc_proto.h`.

- [ ] **Step 4: Run and pass**

Run: `make -C core test`
Expected: pass. Print the new golden bytes for Task 5 with a one-off
`printf` of `ipc_encode_status(sample_status())` (don't commit the printf).

- [ ] **Step 5: Commit** `feat(core): IPC TAKE/LAND, STATUS with stage time and outputs, hold events`

---

### Task 4: Wire the core and prove it end to end against the fake TX module

**Files:**
- Modify: `core/src/mailbox.h`, `core/src/rtloop.c`, `core/src/ipcserver.c`, `core/src/evlog.c`,
  `core/tools/crsf-ctl.c`, `core/tests/test_evlog.c`
- Test: `core/tests/integration/core_client.py`, `core/tests/integration/test_core.py`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `CMD_TAKE`, `CMD_LAND` in `mailbox.h`. `EV_HOLD` (replaces `EV_HANDOVER`): `a` =
  `hold_ev_t`, `b` = `fs_reason_t`, `session`, `cmd_age_ms`. Event-log lines:
  `{"ev":"hold"|"resumed"|"taken"|"landing","reason":"cmd_timeout","session":21,"cmd_age_ms":312}`.
  Refused take/land go to the log as `{"ev":"refused","what":"take"|"land",...}` and to the gateway as
  `IPC_EVENT_TAKE_REFUSED` / `IPC_EVENT_LAND_REFUSED`.

- [ ] **Step 1: Write the failing tests.**
  - `test_evlog.c`: an `EV_HOLD` event with `HOLD_EV_TAKEN`, `FS_PILOT_LOST`, session 9 formats as
    `"ev":"taken","reason":"pilot_lost","session":9`.
  - `core_client.py`: `STATUS_FMT` covers 96 bytes (append `"I3hH4B"`), plus the fields
    `stage_left_ms, out_roll, out_pitch, out_yaw, out_throttle, out_mode, out_speed, out_turtle`.
    Event kinds 4–9 append `("hold"|"resumed"|"taken"|"landing", reason, session)` or
    `("take_refused"|"land_refused", refusal, session)`. Add `TAKE = 0x09`, `LAND = 0x0A`.
  - `test_core.py`: give `CoreHarness` a class attribute `EXTRA_CONF = ""`, appended to the config
    file. Replace `HandoverTest` with `HoldTest`, using `EXTRA_CONF = "hold_ms = 1000\nland_ms = 1000\nhold_throttle = 450\n"`,
    `CH_MODE = 5` and `HT_CH = LOW + (HIGH - LOW) * 450 // 1000` (±2 for rounding). Its tests:
    - `test_pilot_stops_sending_hold_then_land_then_disarm`: a pilot at throttle 300 pauses. Within
      0.45 s the frames show ARM high, throttle ≈ `HT_CH`, CH6 = LOW, roll/pitch/yaw centred, for
      about 1 s. Then throttle = LOW with ARM high for about 1 s, then ARM low. Events, in order:
      `hold`, `landing`, then a state change to FAILSAFE with reason `cmd_timeout`.
    - `test_phone_stall_then_resume_never_drops_arm`: the pilot pauses 0.45 s (a phone stall over the
      tunnel), then resumes at throttle 300. No frame has ARM low. The throttle returns to the pilot's
      value. Events: `hold` then `resumed`.
    - `test_standby_takes_during_hold_without_arm_low`: `STANDBY 22`, pilot A pauses, then
      `TAKE 22`. Pilot B (`announce=False`, throttle 455) starts. No ARM-low frame, the throttle never
      leaves ±5 % of `HT_CH` in the first 300 ms after B's first command, and the events include
      `("taken", "cmd_timeout", 22)`.
    - `test_land_from_the_standby`: `STANDBY 22`, A pauses, `LAND 22` → throttle LOW within 0.1 s,
      then ARM low after about 1 s.
    - `test_take_from_a_stranger_is_refused`: A pauses, `TAKE 23` (no standby set) →
      `("take_refused", "not_standby", 23)`, and the drone still lands on time.
    - `test_hold_off_still_disarms_at_once`: a separate class with `EXTRA_CONF = ""` → ARM low
      within 0.45 s (today's behaviour, kept when `hold_ms = 0`).
  - `StickLogTest`: add an assertion that stick lines keep coming during HOLD (the log covers the
    whole flight, not only ARMED).

- [ ] **Step 2: Run and fail**

Run: `make -C core test && make -C core integration`
Expected: unit `test_evlog` fails; integration fails on the STATUS length (struct.error) and the
missing events.

- [ ] **Step 3: Implement.**
  - `ipcserver.c`: decode `IPC_TAKE`/`IPC_LAND` into `CMD_TAKE`/`CMD_LAND`. In `drain_events`, send
    `EV_HOLD` as event kind `4 + (a - 1)`, and map refusals by command (ARM→1, ACK→2, TAKE→8, LAND→9).
  - `rtloop.c`: `apply()` handles `CMD_TAKE` / `CMD_LAND` (refusals pushed like arm/ack). Replace
    `report_handover` with a loop over `safety_take_report` that pushes `EV_HOLD`. Fill `stage_left_ms`
    and the `out_*` fields in `publish()`. In `log_sticks`, "armed" becomes "in a flight state"
    (ARMED, HOLD or LANDING). In `rtloop_init`, after `safety_init`, call `safety_set_hold` with
    the config's values when `hold_ms > 0`.
  - `evlog.c`: format `EV_HOLD` with `safety_hold_ev_name`, and refusals of `CMD_TAKE`/`CMD_LAND` as
    `"what":"take"|"land"`.
  - `crsf-ctl.c`: print `stage_left_ms` in `status` when it isn't 0 (e.g. `HOLD 3.2 s`).

- [ ] **Step 4: Run and pass**

Run: `make -C core test && make -C core integration`
Expected: all pass. The integration count is 36 − 3 (handover) + 7 (hold) = 40.

- [ ] **Step 5: Commit** `feat(core): wire HOLD/LANDING, TAKE/LAND and hold events end to end`

---

### Task 5: Gateway: the queue head is the standby, take/land, follow `taken`

**Files:**
- Modify: `gateway/src/ipc.js`, `gateway/src/hub.js`
- Test: `gateway/test/ipc.test.js`, `gateway/test/hub.test.js`, `gateway/test/server.test.js`

**Interfaces:**
- Consumes: Task 3's wire format (golden bytes from Task 3 Step 4).
- Produces:
  - `ipc.js`: `MSG.TAKE = 0x09`, `MSG.LAND = 0x0A`; `CoreClient.take(session)`, `CoreClient.land(session)`;
    `STATES = ['DISARMED','ARMED','FAILSAFE','HOLD','LANDING']`. `decodeStatus` expects 96 bytes and adds
    `stageLeftMs` and `out: {roll, pitch, yaw, throttle, mode, speed, turtle}`. `decodeEvent` returns
    `{what:'hold'|'resumed'|'taken'|'landing', reason, session}` for kinds 4–7, and
    `{what:'take'|'land', refused, session}` for kinds 8–9.
  - Hub, browser → gateway: `{t:'take'}` and `{t:'land'}` from the queue head only. `ready` is removed
    (it gets the usual `unknown message type` error).
  - Hub, gateway → browser: `{t:'event', what, reason, session}` for hold events. The taker's
    `welcome` carries `takeover: {r, p, y, th, m, sp, tu}`, built from the last STATUS `out`.
  - `ControlHub` constructor option `log = () => {}`, called with plain objects (Task 6 uses it).

- [ ] **Step 1: Write the failing tests.**
  - `ipc.test.js`: replace `STATUS_GOLDEN` with Task 3's 99 bytes and assert
    `stageLeftMs === 4321`, `out.throttle === 450`, `out.roll === -250`, `out.speed === 2`. `decodeEvent`
    of `[6, 1, 9,0,0,0]` → `{what:'taken', reason:'cmd_timeout', session:9}`, and `[8, 9, 9,0,0,0]` →
    `{what:'take', refused:'not_standby', session:9}`.
  - `hub.test.js`: delete the tests built on «ready» or the `handover` event (`only the standby page is told…`,
    `a ready queued pilot becomes the standby…`, `not-ready standby is withdrawn…`, `pilot socket closes with a standby…`,
    `after a handover the old pilot is queued…`, `after the core comes back, the standby is registered again…`).
    Rewrite `a handover to a standby whose page just left…` as `taken for a taker whose page just left frees the core's seat, then the queue head is seated`
    (same assertions, event `taken`). Then add:
    - `the queue head is the standby without pressing anything`: ana flies, luis joins → `core.calls`
      ends with `['standby', <luis session>]`, and luis's welcome has `standby: true`.
    - `STANDBY follows the queue head when it leaves`: three pilots; the head leaves → `standby` is
      called with the next session; the last one leaves → `standby 0`.
    - `take and land are refused from anyone but the queue head`: `take` from the second in the queue,
      from a spectator and from the pilot → an error reply and no `take` call; from the head →
      `['take', <head session>]`; `land` likewise.
    - `taken seats the new pilot with the drone's current outputs as takeover`: feed
      `onCoreStatus({state:'HOLD', session:<ana>, out:{roll:0,pitch:0,yaw:0,throttle:450,mode:0,speed:1,turtle:0}})`,
      then `onCoreEvent({what:'taken', reason:'cmd_timeout', session:<luis>})` → luis's welcome is
      `{t:'welcome', role:'pilot', session:<luis>, takeover:{r:0,p:0,y:0,th:450,m:0,sp:1,tu:0}}`, ana's
      is `{role:'queued', lost:true, position:1}`, and no `sessionStart` is sent.
    - `taken after the old pilot's page closed seats the taker`: ana detaches (`pilotLost`), then
      `taken` for luis → luis seated, `awaitingCore` false (a later status with session luis doesn't
      reseat anyone).
    - `hold events reach every browser`: `onCoreEvent({what:'hold', reason:'pilot_lost', session})` →
      every client gets `{t:'event', what:'hold', reason:'pilot_lost', session}`.
    - `late bursts over the tunnel are dropped as stale and logged`: with the clock synced (one
      `tsync_r` sample) and `log` captured, deliver ana's commands with `ts` ages 144, 248, 139, 103, 204 ms,
      then nothing for 400 ms, then a fresh one. The 248 and 204 ms commands are not forwarded. `log`
      received `{ev:'stale', name:'ana', ...}` twice and `{ev:'gap', name:'ana', ms:400, ...}`
      (fixed gap: the 2026-10-14 pattern).
    - `core coming back during a hold clears the hold banner state`: status `HOLD`, then `onCoreDown()`
      → the broadcast status has `core:false` and no `stageLeftMs`. Then `onCoreUp()` → the pilot gets
      a fresh session, as today.
  - `server.test.js`: the status buffer is `Buffer.alloc(99)` with length `97`. Replace the
    ready/handover test with `the queue head can take during a hold and the core's taken event gives it the seat`,
    over real sockets: luis sends `take`, the fake core receives `TAKE` with luis's session, the fake
    core sends EVENT kind 6, and luis gets the pilot welcome.

- [ ] **Step 2: Run and fail**

Run: `npm --prefix gateway test`
Expected: failures in ipc (length 80 vs 96), hub (no `take`), server.

- [ ] **Step 3: Implement.**
  - `ipc.js` as in Interfaces. Remove the `handover` branch.
  - `hub.js`:
    - Remove `ready`, `lastControl` and `#standby()`'s ready filter: the standby is `this.queue[0]`.
    - `take`/`land` are handled before the observers check: `if (client === this.queue[0])` → `core.take(c.session)` / `core.land(c.session)`, else `client.send({t:'error', msg:'only the next pilot can take control or land'})`.
    - `onCoreEvent`: `hold`, `resumed`, `landing` → broadcast. `taken` → broadcast, then
      `#follow(ev.session)`: today's `#handover()` body, renamed, with `takeover` from
      `this.lastStatus?.out` mapped to `{r,p,y,th,m,sp,tu}`. `take`/`land` refusals go only to the queue
      head, as `{t:'event', what, refused}`.
    - Update the file's header comment: the queue head is the standby; the hub moves the seat only on
      the core's `taken`.

- [ ] **Step 4: Run and pass**

Run: `npm --prefix gateway test`
Expected: all pass.

- [ ] **Step 5: Commit** `feat(gateway): queue-head standby, take/land, seat follows the core's taken event`

---

### Task 6: Gateway connection log (local, tunnel, relay)

**Files:**
- Create: `gateway/src/connlog.js`
- Modify: `gateway/src/hub.js`, `gateway/src/server.js`, `gateway/src/relayClient.js`,
  `gateway/src/config.js`, `deploy/gateway.json`, `deploy/gcs-gateway.service`
- Test: `gateway/test/connlog.test.js` (new), `gateway/test/hub.test.js`, `gateway/test/config.test.js`

**Interfaces:**
- Consumes: Task 5's `log` option.
- Produces:
  - `export function openConnLog(file: string | null): { write(obj): void, close(): Promise<void> }`.
    `null` writes `gateway: <json>` to stdout. A path appends one JSON line per call, each with
    `t` (ISO time) first. It never throws on a write error (logs one `console.error` and carries on).
  - Hub `auth` gains `via: 'local' | 'tunnel' | 'relay'`. The server sets
    `req.headers['cf-connecting-ip'] ? 'tunnel' : 'local'`, and the relay client sets `'relay'`.
  - Hub log lines, all with `name` and `via`:
    - `{ev:'join', role}` at hello;
    - `{ev:'leave', role, connectedS}` at detach;
    - `{ev:'seat', how:'free'|'taken'}`;
    - `{ev:'gap', ms}` (> 250 ms between valid commands from the active pilot);
    - `{ev:'stale', ageMs}`;
    - `{ev:'hold'|'resumed'|'taken'|'landing', reason}`, with `name` = the active pilot's name.
  - Config key `eventLog: null | string` (validated as null or a path). `deploy/gateway.json` sets
    `"/var/log/gcs-gateway/events.jsonl"`, and `gcs-gateway.service` gets `LogsDirectory=gcs-gateway`.

- [ ] **Step 1: Write the failing tests.**
  - `connlog.test.js`: `openConnLog(tmpfile)` → two `write`s → two JSON lines with `t` first and the
    fields kept. `openConnLog(null)` writes to stdout (spy on `console.log`). Writing into a missing
    directory does not throw.
  - `hub.test.js`, `the connection log names who, how and when`: a `tunnel` pilot joins and flies; a
    `local` one queues; a 300 ms gap; the pilot leaves. Assert the sequence of `ev` values and that no
    entry has a key matching `/ip|pass/i`.
  - `config.test.js`: `eventLog: 5` is refused; `null` and a string are accepted.

- [ ] **Step 2: Run and fail**

Run: `npm --prefix gateway test`
Expected: `Cannot find module '../src/connlog.js'`, and the hub log assertions fail.

- [ ] **Step 3: Implement** as in Interfaces. `server.js` opens the log from `cfg.eventLog`, passes
  `log: connlog.write` to the hub, and closes it in `close()`. The gap is measured at arrival
  (`this.now()`) between valid commands from the seated pilot. It resets on every seat change.

- [ ] **Step 4: Run and pass**

Run: `npm --prefix gateway test`
Expected: all pass.

- [ ] **Step 5: Commit** `feat(gateway): connection log with local/tunnel/relay path, gaps and stale drops`

---

### Task 7: Pilot page: the hold banner, take/land, new labels, no «Listo»

**Files:**
- Modify: `web/js/view.js`, `web/js/app.js`, `web/index.html`, the page stylesheet under `web/css/`
- Test: `web/test/view.test.js`

**Interfaces:**
- Consumes: Task 5's status (`state`, `stageLeftMs`, `pilotName`), events and the `takeover` welcome.
- Produces (in `view.js`):
  - `holdBanner(status, { role, standby }) → null | { text: string, take: boolean, land: boolean }`
  - `STATE_TEXT` gains `HOLD: 'ESPERA · SIN PILOTO'`, `LANDING: 'ATERRIZANDO'`.
  - `queueText` standby wording per Global Constraints.

- [ ] **Step 1: Write the failing tests** in `web/test/view.test.js`:

```js
test('hold banner for the queue head: name, whole seconds left, both buttons', () => {
  const st = { state: 'HOLD', stageLeftMs: 3400, pilotName: 'ana' };
  assert.deepEqual(holdBanner(st, { role: 'queued', standby: true }),
    { text: 'ana perdió la conexión · aterriza en 4 s', take: true, land: true });
});
test('during LANDING the queue head can only take', () => {
  assert.deepEqual(holdBanner({ state: 'LANDING', stageLeftMs: 2000, pilotName: 'ana' }, { role: 'queued', standby: true }),
    { text: 'Aterrizando…', take: true, land: false });
});
test('everyone else sees the countdown without buttons; nothing outside a hold', () => {
  const st = { state: 'HOLD', stageLeftMs: 900, pilotName: 'ana' };
  assert.deepEqual(holdBanner(st, { role: 'observer' }), { text: 'ana perdió la conexión · aterriza en 1 s', take: false, land: false });
  assert.deepEqual(holdBanner(st, { role: 'queued', standby: false }), { text: 'ana perdió la conexión · aterriza en 1 s', take: false, land: false });
  assert.equal(holdBanner({ state: 'ARMED' }, { role: 'queued', standby: true }), null);
});
test('state pill and queue text for the hold', () => {
  assert.equal(stateLabel({ core: true, state: 'HOLD' }, true), 'ESPERA · SIN PILOTO');
  assert.equal(stateLabel({ core: true, state: 'LANDING' }, true), 'ATERRIZANDO');
  assert.equal(queueText({ role: 'queued', standby: true }, { pilotName: 'ana' }),
    'Estás en espera. Si ana pierde la conexión, podrás tomar el control o aterrizar.');
});
```

  The main pilot's page (role `pilot`) gets `null` from `holdBanner`: their page keeps flying and only
  shows the state pill.

- [ ] **Step 2: Run and fail**

Run: `npm --prefix gateway test`
Expected: `holdBanner is not a function`, and the label assertions fail.

- [ ] **Step 3: Implement.**
  - `view.js`: `holdBanner`, the labels and the queue text as tested. Seconds are `Math.ceil(stageLeftMs / 1000)`.
  - `index.html`: replace `#btn-ready` with a `#hold-banner` inside `.video`, absolutely positioned at
    the top of the video, not covering it (mockup B). It has `#hold-text`, `#btn-hold-take` «Tomar el
    control» and `#btn-hold-land` «Aterrizar». Add `role="alert"`.
  - `app.js`:
    - Remove `readySent`, `setReady`, the «Listo» handler and the queued-Esc branch. `disengage()`
      becomes just `deadman.disengage`.
    - `render()` fills the banner from `holdBanner(status, {role, standby: queued?.standby === true})`.
    - «Tomar el control»: `await takeControl()` (full screen, orientation, dead-man), then
      `send({t:'take'})`. «Aterrizar»: `send({t:'land'})`.
    - On a pilot welcome with `takeover`, the existing `takeOver()` seeds from it.
    - On `{t:'event', what:'resumed', session}` matching this page's session: toast
      `Conexión recuperada`.
    - On `{t:'event', what:'take'|'land', refused}`: toast `Ya no es posible: el dron ya no está en espera`.
    - Update the file header comment (no more «Listo»; the queue head gets the choice).

- [ ] **Step 4: Run and pass**

Run: `npm --prefix gateway test`
Expected: all pass. Then open the page on a phone (local Wi-Fi) with a fake core: the banner sits over
the video in landscape, and the video stays visible.

- [ ] **Step 5: Commit** `feat(web): hold banner over the video with take/land; «Listo» removed`

---

### Task 8: Browser e2e: hold, take, land by itself

**Files:**
- Create: `gateway/e2e/hold.e2e.js`
- Delete: `gateway/e2e/handover.e2e.js`

**Interfaces:**
- Consumes: everything above. Reuses the structure of `handover.e2e.js` (fake TX, core, gateway, two
  Firefox profiles, `tempDir`, `press`, frame capture). The core config adds
  `hold_ms = 3000\nland_ms = 1000\nhold_throttle = 450\n` (R7). `HT = LOW + (HIGH - LOW) * 0.45`.

- [ ] **Step 1: Write the tests**
  - `closing the pilot page: luis takes during the hold, ARM never drops, the throttle starts at the hold value`:
    ana flies at about 30 %; her Firefox is killed. Wait until luis's `#hold-banner` is visible and
    `#btn-hold-take` is enabled, then click it. Wait for `TIENES EL CONTROL`. Assert every frame from
    the kill to 1 s after the take has ARM high, and that in the 500 ms after the take, throttle stays
    within 5 % of `HT`.
  - `ana lets go with Esc: same as above`: the same flow with Esc on ana's page instead of the kill.
    Ana's page stays connected, so after the take she sees `Perdiste el control: ahora vuela luis`.
  - `nobody chooses: hold, landing, then ARM low on time`: ana's page is killed, and luis does
    nothing. The frames show throttle ≈ `HT` with ARM high for 3000 ms (±300), then LOW throttle with
    ARM high for 1000 ms (±300), then ARM low.
  - All three: `assert.deepEqual(page.errors, [])` on every page still open.

- [ ] **Step 2: Run them**

Run: `make -C core && vcgencmd measure_temp && npm --prefix gateway run e2e`
Expected: 10 e2e tests (9 − 2 handover + 3 hold) pass. Run the three hold tests **three times** on the
Pi, letting it cool to below 60 °C between runs. All 9 runs must pass, which confirms the 2026-10-21
flakiness is gone (spec §5). Record the runs in the ledger.

- [ ] **Step 3: Commit** `test(e2e): hold-then-land replaces the handover browser test`

---

### Task 9: Documentation, the bench procedure (phones, local and tunnel) and the deployment gate

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (§3.2, §5.3),
  `docs/superpowers/specs/2026-10-07-aquila20-profile-design.md` (§3.3),
  `docs/superpowers/specs/2026-10-20-pilot-auth-handover-design.md` (goals 4–5, A7, A9, A10, §4.3–4.5),
  `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, `docs/procedures/m4-pilot-checklist.md`
- Create: `docs/procedures/hold-bench-test.md`, `docs/superpowers/ledgers/2026-10-22-hold-then-land.md`

- [ ] **Step 1: Amend the specs.** For each place listed in spec §7, add a dated note pointing to the
  hold-then-land spec, and replace the instant-stop wording. In the M4 checklist's pilot briefing, add:
  "Desarmar is the only way to stop the motors in flight; letting go (Esc, hidden tab) now holds, then
  lands."

- [ ] **Step 2: Write `docs/procedures/hold-bench-test.md`.** Propellers off, TX module on XT30 (2S, never
  3S, antenna on), `hold_ms`/`land_ms`/`hold_throttle` set to bench values in `/etc/gcs/crsf-core.conf`.
  Check each with `crsf-ctl watch` and the stick log:
  1. hold → take (second phone presses «Tomar el control»);
  2. hold → «Aterrizar»;
  3. hold → lands by itself;
  4. resume: main pilot's phone in airplane mode for 2 s, then back;
  5. the same four **with both phones on the Cloudflare tunnel URL**. Check
     `/var/log/gcs-gateway/events.jsonl` names each pilot with `"via":"tunnel"` and logs the gaps;
  6. Desarmar during a hold stops the motors at once.

  Include a results table: step, path (local/tunnel), expected, seen, pass.

- [ ] **Step 3: Update `HANDOFF.md`.**
  - Suite counts: integration 40; gateway count as measured; e2e 10.
  - The new settings, and the rule that `hold_ms` stays 0 until §8.
  - The connection log location.
  - The deployment gate:
    - `install.sh` keeps the existing `/etc/gcs/*.conf`, so after installing, replace
      `/etc/gcs/gateway.json` (new `eventLog`) and edit `crsf-core.conf` by hand.
    - **Installing this build with `hold_ms = 0` removes the automatic handover:** a lost pilot means an
      instant FAILSAFE, with no standby rescue. So install it on the Pi only together with the §8
      values.

- [ ] **Step 4: Write the ledger** with a `Ruling:` line for each of R1–R7, plus anything decided while
  executing. Record the e2e runs from Task 8.

- [ ] **Step 5: Run every suite** (`docs/HANDOFF.md` §5) and record the counts.

- [ ] **Step 6: Commit** `docs: hold-then-land in the specs, bench procedure, handoff and ledger`

## Done when

- All suites pass: C unit, integration (40), relay (11), gateway + web, tools/analysis (26), browser
  e2e (10, three hold runs clean on the Pi).
- The bench procedure is written. Running it, and the §8 flight that measures `hold_throttle` and
  `land_ms`, happen after the team approves (spec §8). Until then, `hold_ms = 0` and this build is not
  installed on the Pi.
