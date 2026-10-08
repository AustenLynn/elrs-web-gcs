# M8: Aquila20 Flight-Controller Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make crsf-core fail safe correctly on the project drone, a BetaFPV Aquila20 HD running BetaFPV's own firmware (not Betaflight): FAILSAFE disarms it over a live link, CH7 (its stick sensitivity) stays at S, and its flight-mode text is never read as "armed". Betaflight behaviour stays available as a profile.

**Architecture:** One setting, `fc_profile = aquila20 | betaflight` (default `aquila20`). The safety state machine is unchanged: it still decides *when* to fail safe. The profile only changes *how* failsafe reaches the channels (`chmap.c`) and whether flight-mode telemetry feeds the FC-armed check (`rtloop.c`). The pilot page gets N/S/M mode labels and shows the Aquila20's mode text in Spanish.

**Tech Stack:** C (gnu11) for crsf-core, Python 3 `unittest` integration tests with the fake TX, Node 22 tests for the page, headless Firefox for the browser test.

**Spec:** `docs/superpowers/specs/2026-10-07-aquila20-profile-design.md` (it amends `2026-10-05-elrs-web-gcs-design.md`; read §2 for what the drone does).

**Before you start:** Milestones 1–7 software are done (`docs/HANDOFF.md`). All suites pass: `make -C core test integration`, `npm --prefix gateway test`, `npm --prefix gateway run e2e`. No hardware is needed for this plan.

## Global Constraints

- Work in `~/ProyectoTerminal/elrs-web-gcs` on `main`; run every command from the repository root. Commit messages end with the session trailer lines (see `CLAUDE.md`).
- C flags `-std=gnu11 -Wall -Wextra -Werror -Wshadow -Wstrict-prototypes`; unit tests build with UBSan.
- `fc_profile` values are exactly `aquila20` and `betaflight`; the default is `aquila20`.
- Aquila20 channel map (spec §2): CH5 ARM (high armed), CH6 flight mode low/mid/high = NORMAL/SPORT/MANUAL (N/S/M), CH7 stick sensitivity (crsf-core keeps it at 1000 µs = S).
- In `aquila20`, FAILSAFE = ARM low, sticks centred, throttle minimum, link kept up. In `betaflight`, behaviour must stay byte-for-byte what it is today.
- The safety state machine (`safety.c`) does not change.
- Expected compiler and Python messages are quoted in English; this Pi prints some in Spanish.

## Review Focus

Inputs and failure modes most likely to hurt a real user; each is pinned by a test in the task named.

1. A failsafe while armed must disarm the Aquila20 even though the safety outputs still say `arm = true` (Task 2, `test_aquila20_failsafe_drops_arm_and_keeps_ch7_low`).
2. No configuration may put a stick or switch on CH7 under `aquila20` (it would change stick sensitivity mid-flight) (Task 1, `test_aquila20_keeps_ch7_for_its_sensitivity_switch`).
3. The Aquila20's mode text (`S-NORMAL`) must never block clearing a failsafe (Task 3, `test_flight_mode_text_never_blocks_clearing_failsafe`).
4. The Betaflight profile keeps CH7 FAILSAFE and the `*` interlock end to end (Tasks 2–3, `BetaflightTest`).
5. The page loses focus → ARM low within 1 s, sensitivity still S (Task 2, browser test).

---

## File Structure

| File | Change |
|------|--------|
| `core/src/config.h, config.c` | `fc_profile_t`, `AQUILA20_SENSITIVITY_CH`, parsing and validation |
| `core/src/chmap.c, chmap.h` | FAILSAFE output per profile |
| `core/src/rtloop.c` | flight-mode text feeds the FC-armed check only in `betaflight` |
| `core/tests/test_config.c, test_chmap.c` | unit tests per profile |
| `core/tests/integration/test_core.py` | profile-aware harness, `BetaflightTest`, new Aquila20 tests |
| `deploy/crsf-core.conf` | `fc_profile = aquila20` |
| `gateway/e2e/pilot.e2e.js` | failsafe on the air = ARM low |
| `web/js/view.js, web/js/app.js, web/index.html, web/test/view.test.js` | N/S/M labels, Spanish mode text |
| `docs/setup/aquila20.md, main spec, docs/HANDOFF.md` | the drone, the amendment, the handoff |

### Task 1: The `fc_profile` setting

**Files:**
- Modify: `core/src/config.h`
- Modify: `core/src/config.c`
- Modify: `deploy/crsf-core.conf`
- Test: `core/tests/test_config.c`

**Interfaces:**
- Consumes: nothing new
- Produces: `typedef enum { FC_PROFILE_AQUILA20 = 0, FC_PROFILE_BETAFLIGHT = 1 } fc_profile_t;`, `config_t.fc_profile` (default `FC_PROFILE_AQUILA20`), `#define AQUILA20_SENSITIVITY_CH 6` (0-based CH7); `config_set(c, "fc_profile", "aquila20"|"betaflight", …)`

- [ ] **Step 1: Write the failing tests**

In `core/tests/test_config.c` (change 1 of 3), replace:

```c
    CHECK_EQ_INT(config_set(&c, "status_socket_path", "/run/crsf-core/status.sock", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
}

```

with:

```c
    CHECK_EQ_INT(config_set(&c, "status_socket_path", "/run/crsf-core/status.sock", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
}

static void test_fc_profile_defaults_to_aquila20(void)
{
    /* The project drone (BetaFPV Aquila20) does not run Betaflight; Betaflight stays selectable. */
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_AQUILA20);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "betaflight", err, sizeof err), 0);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_BETAFLIGHT);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "aquila20", err, sizeof err), 0);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_AQUILA20);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "inav", err, sizeof err), -1);
    CHECK(strstr(err, "aquila20 or betaflight") != NULL);
}

static void test_aquila20_keeps_ch7_for_its_sensitivity_switch(void)
{
    /* On the Aquila20, CH7 selects stick sensitivity: it must stay at its default (low = S).
     * ch_failsafe is not used, so it may point anywhere without clashing. */
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "ch_yaw", "7", err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "ch_failsafe", "4", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK(strstr(err, "CH7") != NULL);
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_failsafe", "4", err, sizeof err), 0);   /* same as ch_yaw: unused */
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "betaflight", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);                /* betaflight uses it */
}

```

In `core/tests/test_config.c` (change 2 of 3), replace:

```c
    CHECK(c.rt_required);
    CHECK_EQ_INT(c.ch_failsafe, 6);
    CHECK_STR(c.timing_log, "");
    CHECK_STR(c.status_socket_path, "/run/crsf-core/status.sock");
```

with:

```c
    CHECK(c.rt_required);
    CHECK_EQ_INT(c.ch_failsafe, 6);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_AQUILA20);
    CHECK_STR(c.timing_log, "");
    CHECK_STR(c.status_socket_path, "/run/crsf-core/status.sock");
```

In `core/tests/test_config.c` (change 3 of 3), replace:

```c
{
    RUN(test_defaults_are_valid);
    RUN(test_status_socket_is_separate_from_the_control_socket);
    RUN(test_load_file_with_comments_and_spaces);
```

with:

```c
{
    RUN(test_defaults_are_valid);
    RUN(test_fc_profile_defaults_to_aquila20);
    RUN(test_aquila20_keeps_ch7_for_its_sensitivity_switch);
    RUN(test_status_socket_is_separate_from_the_control_socket);
    RUN(test_load_file_with_comments_and_spaces);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_config.c:50:19: error: 'config_t' has no member named 'fc_profile'` and `'FC_PROFILE_AQUILA20' undeclared`

- [ ] **Step 3: Add the setting**

In `core/src/config.h` (change 1 of 2), replace:

```c

#define CONFIG_PATH_MAX 256

typedef struct {
```

with:

```c

#define CONFIG_PATH_MAX 256

/* Which flight-controller firmware is on the aircraft (docs/superpowers/specs/
 * 2026-10-07-aquila20-profile-design.md):
 *  - AQUILA20: BetaFPV's own firmware. FAILSAFE drops ARM over a live link; CH7 is the
 *    drone's stick-sensitivity switch and stays low (S); the flight-mode text never says
 *    whether the drone is armed.
 *  - BETAFLIGHT: FAILSAFE raises the ch_failsafe switch and leaves ARM to Betaflight;
 *    a flight mode ending in '*' means disarmed. */
typedef enum { FC_PROFILE_AQUILA20 = 0, FC_PROFILE_BETAFLIGHT = 1 } fc_profile_t;

/* The Aquila20's stick-sensitivity switch (0-based CH7): no function may use it. */
#define AQUILA20_SENSITIVITY_CH 6

typedef struct {
```

In `core/src/config.h` (change 2 of 2), replace:

```c
    int rt_cpu;                        /* CPU the frame loop is pinned to; -1 = no pinning */
    bool rt_required;                  /* refuse to run if real-time setup fails */
    int stick_min_us;
    int stick_max_us;
```

with:

```c
    int rt_cpu;                        /* CPU the frame loop is pinned to; -1 = no pinning */
    bool rt_required;                  /* refuse to run if real-time setup fails */
    fc_profile_t fc_profile;           /* "aquila20" (default) or "betaflight" */
    int stick_min_us;
    int stick_max_us;
```

In `core/src/config.c` (change 1 of 3), replace:

```c
    c->ch_arm = 4;       /* CH5 = AUX1: ExpressLRS sends it with every packet */
    c->ch_mode = 5;      /* CH6 = AUX2 */
    c->ch_failsafe = 6;  /* CH7 = AUX3 */
}

```

with:

```c
    c->ch_arm = 4;       /* CH5 = AUX1: ExpressLRS sends it with every packet */
    c->ch_mode = 5;      /* CH6 = AUX2 */
    c->ch_failsafe = 6;  /* CH7 = AUX3 (betaflight profile only) */
    c->fc_profile = FC_PROFILE_AQUILA20;
}

```

In `core/src/config.c` (change 2 of 3), replace:

```c
        }
    }
    if (!strcmp(key, "rt_required")) {
        if (parse_bool(value, &c->rt_required) == 0)
```

with:

```c
        }
    }
    if (!strcmp(key, "fc_profile")) {
        if (!strcmp(value, "aquila20"))
            c->fc_profile = FC_PROFILE_AQUILA20;
        else if (!strcmp(value, "betaflight"))
            c->fc_profile = FC_PROFILE_BETAFLIGHT;
        else {
            snprintf(err, errlen, "fc_profile: expected aquila20 or betaflight, got \"%s\"", value);
            return -1;
        }
        return 0;
    }
    if (!strcmp(key, "rt_required")) {
        if (parse_bool(value, &c->rt_required) == 0)
```

In `core/src/config.c` (change 3 of 3), replace:

```c
        return fail(err, errlen, "ch_arm must be 5: ExpressLRS sends AUX1 (CH5) with every packet");

    const int chans[] = { c->ch_roll, c->ch_pitch, c->ch_throttle, c->ch_yaw,
                          c->ch_arm, c->ch_mode, c->ch_failsafe };
    const int n = (int)(sizeof chans / sizeof chans[0]);
    for (int i = 0; i < n; i++) {
        if (chans[i] < 0 || chans[i] > 15)
            return fail(err, errlen, "channel numbers must be 1..16");
```

with:

```c
        return fail(err, errlen, "ch_arm must be 5: ExpressLRS sends AUX1 (CH5) with every packet");

    /* ch_failsafe is a function only in the betaflight profile (it comes last). */
    const int chans[] = { c->ch_roll, c->ch_pitch, c->ch_throttle, c->ch_yaw,
                          c->ch_arm, c->ch_mode, c->ch_failsafe };
    const int n = (int)(sizeof chans / sizeof chans[0]) - (c->fc_profile == FC_PROFILE_AQUILA20 ? 1 : 0);
    for (int i = 0; i < n; i++) {
        if (c->fc_profile == FC_PROFILE_AQUILA20 && chans[i] == AQUILA20_SENSITIVITY_CH)
            return fail(err, errlen, "fc_profile aquila20: CH7 is the drone's sensitivity switch, "
                                     "no function may use it");
        if (chans[i] < 0 || chans[i] > 15)
            return fail(err, errlen, "channel numbers must be 1..16");
```

- [ ] **Step 4: Set it in the shipped config**

In `deploy/crsf-core.conf`, replace:

```ini
rt_cpu = 3
rt_required = true
# Channel layout (1-based). Betaflight: map AETR1234, ARM on AUX1, FAILSAFE mode on AUX3.
ch_roll = 1
ch_pitch = 2
```

with:

```ini
rt_cpu = 3
rt_required = true
# Flight controller firmware: aquila20 (BetaFPV Aquila20: FAILSAFE disarms over the link,
# CH7 = its stick sensitivity, kept at S) or betaflight (FAILSAFE switch on ch_failsafe).
fc_profile = aquila20
# Channel layout (1-based). Aquila20: CH5 ARM, CH6 flight mode N/S/M, CH7 sensitivity (not
# used). Betaflight: map AETR1234, ARM on AUX1, FAILSAFE mode on AUX3 (ch_failsafe).
ch_roll = 1
ch_pitch = 2
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `make -C core test && make -C core integration`

Expected: PASS: `PASS test_fc_profile_defaults_to_aquila20`, `PASS test_aquila20_keeps_ch7_for_its_sensitivity_switch`, `ALL TESTS PASSED`; integration `Ran 26 tests` … `OK` (nothing reads the setting yet)

- [ ] **Step 6: Commit**

```bash
git add core/src/config.h core/src/config.c core/tests/test_config.c deploy/crsf-core.conf
git commit -m "core: fc_profile setting (aquila20 default, betaflight kept)"
```

### Task 2: Failsafe on the air per profile

Changing the default profile changes what failsafe looks like on the air, so the integration and browser tests that waited for "CH7 high" are updated in this task too: they now ask the harness what failsafe looks like in their profile.

**Files:**
- Modify: `core/src/chmap.c`
- Modify: `core/src/chmap.h`
- Test: `core/tests/test_chmap.c`
- Test: `core/tests/integration/test_core.py`
- Test: `gateway/e2e/pilot.e2e.js`

**Interfaces:**
- Consumes: `config_t.fc_profile`, `FC_PROFILE_*` (Task 1)
- Produces: `chmap_build()`: in `aquila20`, ARM = `arm && !failsafe` and `ch_failsafe` is never written; in `betaflight`, unchanged. Integration harness: `CoreHarness.PROFILE` (default `"aquila20"`), `CoreHarness.failsafe_on(ch)`, class `BetaflightTest`

- [ ] **Step 1: Write the failing unit test**

In `core/tests/test_chmap.c` (change 1 of 3), replace:

```c
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { .roll = 1000, .pitch = -1000, .yaw = 500, .throttle = 1000,
                       .mode = 1, .arm = true, .failsafe = true };
```

with:

```c
    config_t c;
    config_defaults(&c);
    c.fc_profile = FC_PROFILE_BETAFLIGHT;   /* FAILSAFE is a switch on CH7 */
    rc_outputs_t o = { .roll = 1000, .pitch = -1000, .yaw = 500, .throttle = 1000,
                       .mode = 1, .arm = true, .failsafe = true };
```

In `core/tests/test_chmap.c` (change 2 of 3), replace:

```c
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);
}

```

with:

```c
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);
}

static void test_aquila20_failsafe_drops_arm_and_keeps_ch7_low(void)
{
    /* The Aquila20 has no failsafe switch: FAILSAFE must disarm it, and CH7 (its stick
     * sensitivity) stays at the slowest setting whatever happens. */
    config_t c;
    config_defaults(&c);                    /* fc_profile aquila20 */
    rc_outputs_t o = { .throttle = 500, .mode = 2, .arm = true };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[4]), 2000);   /* armed while flying */
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 1000);   /* sensitivity S */
    o.failsafe = true;                          /* arm stays true in the safety outputs */
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[4]), 1000);   /* ARM low: the drone disarms */
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 1000);   /* still S, never a "failsafe switch" */
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);   /* flight mode passed through unchanged */
}

```

In `core/tests/test_chmap.c` (change 3 of 3), replace:

```c
    RUN(test_neutral_outputs);
    RUN(test_full_deflection_and_switches);
    RUN(test_out_of_range_inputs_are_clamped);
    RUN(test_custom_channel_order);
```

with:

```c
    RUN(test_neutral_outputs);
    RUN(test_full_deflection_and_switches);
    RUN(test_aquila20_failsafe_drops_arm_and_keeps_ch7_low);
    RUN(test_out_of_range_inputs_are_clamped);
    RUN(test_custom_channel_order);
```

- [ ] **Step 2: Run the tests to see it fail**

Run: `make -C core test`

Expected: FAIL: `tests/test_chmap.c:56: CHECK_EQ_INT failed: crsf_ch_to_us(ch[4]) == 1000 (2000 != 1000)`, `tests/test_chmap.c:57: … crsf_ch_to_us(ch[6]) == 1000 (2000 != 1000)`, `FAIL test_aquila20_failsafe_drops_arm_and_keeps_ch7_low`

- [ ] **Step 3: Map failsafe per profile**

In `core/src/chmap.c`, replace:

```c
    ch[c->ch_throttle] = crsf_us_to_ch(c->stick_min_us + clampi(o->throttle, 0, 1000) * span / 1000);
    ch[c->ch_mode] = crsf_us_to_ch(c->stick_min_us + mode * span / 2);
    ch[c->ch_arm] = sw(c, o->arm);
    ch[c->ch_failsafe] = sw(c, o->failsafe);
}
```

with:

```c
    ch[c->ch_throttle] = crsf_us_to_ch(c->stick_min_us + clampi(o->throttle, 0, 1000) * span / 1000);
    ch[c->ch_mode] = crsf_us_to_ch(c->stick_min_us + mode * span / 2);
    if (c->fc_profile == FC_PROFILE_BETAFLIGHT) {
        ch[c->ch_arm] = sw(c, o->arm);               /* Betaflight decides what FAILSAFE does */
        ch[c->ch_failsafe] = sw(c, o->failsafe);
    } else {
        ch[c->ch_arm] = sw(c, o->arm && !o->failsafe);   /* Aquila20: FAILSAFE = disarm */
    }
}
```

In `core/src/chmap.h`, replace:

```c
    uint8_t mode;              /* flight-mode switch position 0..2 */
    bool arm;                  /* ARM switch high */
    bool failsafe;             /* FAILSAFE switch high */
} rc_outputs_t;

```

with:

```c
    uint8_t mode;              /* flight-mode switch position 0..2 */
    bool arm;                  /* ARM switch high */
    bool failsafe;             /* in FAILSAFE (betaflight: switch high; aquila20: ARM forced low) */
} rc_outputs_t;

```

- [ ] **Step 4: Run the unit tests, then see which integration tests still expect CH7**

Run: `make -C core test && make -C core integration`

Expected: `ALL TESTS PASSED`; integration FAILs exactly these 6 (they wait for CH7 high): `test_malformed_message_drops_the_gateway_and_fails_safe`, `test_newest_gateway_wins_and_the_old_one_fails_safe`, `test_ack_is_refused_while_fc_reports_armed`, `test_burst_then_disconnect_fails_safe_at_once`, `test_command_timeout_triggers_failsafe_within_budget`, `test_gateway_disconnect_triggers_failsafe`, then `FAILED (failures=6)`

- [ ] **Step 5: Make the integration harness profile-aware**

The ack test needs Betaflight's `*` interlock, so it moves into a `BetaflightTest` class that runs crsf-core with `fc_profile = betaflight`; that also keeps CH7 FAILSAFE covered end to end.

In `core/tests/integration/test_core.py` (change 1 of 8), replace:

```python
CORE = os.path.join(CORE_DIR, "build", "crsf-core")
CTL = os.path.join(CORE_DIR, "build", "crsf-ctl")
CH_ARM, CH_FAILSAFE, CH_THROTTLE = 4, 6, 2
HIGH, LOW = 1792, 192


class CoreHarness(unittest.TestCase):
    def setUp(self):
        # addCleanup (not tearDown) so a failure half-way through setUp still stops everything
```

with:

```python
CORE = os.path.join(CORE_DIR, "build", "crsf-core")
CTL = os.path.join(CORE_DIR, "build", "crsf-ctl")
CH_ARM, CH_FAILSAFE, CH_THROTTLE = 4, 6, 2   # CH_FAILSAFE: betaflight profile only
CH_SENSITIVITY = 6                            # aquila20: CH7 is the drone's sensitivity switch
HIGH, LOW = 1792, 192


class CoreHarness(unittest.TestCase):
    PROFILE = "aquila20"          # fc_profile; subclasses may choose "betaflight"

    def failsafe_on(self, ch):
        """What FAILSAFE looks like on the air in this profile."""
        if self.PROFILE == "betaflight":
            return ch[CH_FAILSAFE] == HIGH                       # FAILSAFE switch high
        return ch[CH_ARM] == LOW and ch[CH_SENSITIVITY] == LOW   # disarmed, sensitivity still S

    def setUp(self):
        # addCleanup (not tearDown) so a failure half-way through setUp still stops everything
```

In `core/tests/integration/test_core.py` (change 2 of 8), replace:

```python
            f.write("event_log = %s\n" % self.events)
            f.write("rt_priority = 0\nrt_cpu = -1\n")
        self.proc = subprocess.Popen([CORE, "-c", conf], stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_core)
```

with:

```python
            f.write("event_log = %s\n" % self.events)
            f.write("rt_priority = 0\nrt_cpu = -1\n")
            f.write("fc_profile = %s\n" % self.PROFILE)
        self.proc = subprocess.Popen([CORE, "-c", conf], stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_core)
```

In `core/tests/integration/test_core.py` (change 3 of 8), replace:

```python
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], LOW)
        self.assertEqual(ch[CH_FAILSAFE], LOW)
        self.assertEqual(ch[CH_THROTTLE], LOW)

```

with:

```python
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], LOW)
        self.assertEqual(ch[CH_SENSITIVITY], LOW)
        self.assertEqual(ch[CH_THROTTLE], LOW)

```

In `core/tests/integration/test_core.py` (change 4 of 8), replace:

```python
        pilot.paused = True                                # pilot freezes (e.g. Wi-Fi drop)
        t_stop = time.monotonic()
        t_fs = self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=2)
        pilot.stop()
        self.assertIsNotNone(t_fs, "FAILSAFE channel never went high")
        self.assertLess(t_fs - t_stop, 0.45)               # 300 ms timeout + scheduling slack
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], HIGH)                 # Betaflight runs its own procedure
        self.assertEqual(ch[CH_THROTTLE], LOW)
        self.assertTrue(self.client.wait(lambda c: c.status["reason_name"] == "cmd_timeout"))
```

with:

```python
        pilot.paused = True                                # pilot freezes (e.g. Wi-Fi drop)
        t_stop = time.monotonic()
        t_fs = self.tx.wait_for(self.failsafe_on, timeout=2)
        pilot.stop()
        self.assertIsNotNone(t_fs, "failsafe never reached the channels")
        self.assertLess(t_fs - t_stop, 0.45)               # 300 ms timeout + scheduling slack
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], LOW)                  # aquila20: failsafe disarms the drone
        self.assertEqual(ch[CH_THROTTLE], LOW)
        self.assertTrue(self.client.wait(lambda c: c.status["reason_name"] == "cmd_timeout"))
```

In `core/tests/integration/test_core.py` (change 5 of 8), replace:

```python
        pilot.stop()
        self.client.close()
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))
```

with:

```python
        pilot.stop()
        self.client.close()
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))
```

In `core/tests/integration/test_core.py` (change 6 of 8), replace:

```python
        self.client.close()
        t0 = time.monotonic()
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))
        self.assertLess(time.monotonic() - t0, 0.15)
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_ack_is_refused_while_fc_reports_armed(self):
```

with:

```python
        self.client.close()
        t0 = time.monotonic()
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))
        self.assertLess(time.monotonic() - t0, 0.15)
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_arm_refused_with_throttle_up(self):
        pilot = Pilot(self.client, session=14, throttle=400)
        self.assertTrue(self.client.wait(lambda c: c.status["last_seq"] > 0))
        self.client.send(ARM, 14)
        self.assertTrue(self.client.wait(lambda c: ("arm_refused", "throttle_high", 14) in c.events))
        pilot.stop()
        self.assertEqual(self.tx.last_channels()[CH_ARM], LOW)


class BetaflightTest(CoreHarness):
    PROFILE = "betaflight"

    def test_ack_is_refused_while_fc_reports_armed(self):
```

In `core/tests/integration/test_core.py` (change 7 of 8), replace:

```python
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "DISARMED"))  # status is 10 Hz

    def test_arm_refused_with_throttle_up(self):
        pilot = Pilot(self.client, session=14, throttle=400)
        self.assertTrue(self.client.wait(lambda c: c.status["last_seq"] > 0))
        self.client.send(ARM, 14)
        self.assertTrue(self.client.wait(lambda c: ("arm_refused", "throttle_high", 14) in c.events))
        pilot.stop()
        self.assertEqual(self.tx.last_channels()[CH_ARM], LOW)


class ResilienceTest(CoreHarness):
```

with:

```python
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "DISARMED"))  # status is 10 Hz


class ResilienceTest(CoreHarness):
```

In `core/tests/integration/test_core.py` (change 8 of 8), replace:

```python
        pilot.stop()
        self.client.sock.sendall(struct.pack("<HB", 1, 0x55))   # unknown message type
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))

    def test_newest_gateway_wins_and_the_old_one_fails_safe(self):
        pilot = Pilot(self.client, session=22)
        self.arm(pilot)
        second = CoreClient(self.sock)
        self.addCleanup(second.close)
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))
        pilot.stop()
        self.assertTrue(second.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))
```

with:

```python
        pilot.stop()
        self.client.sock.sendall(struct.pack("<HB", 1, 0x55))   # unknown message type
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))

    def test_newest_gateway_wins_and_the_old_one_fails_safe(self):
        pilot = Pilot(self.client, session=22)
        self.arm(pilot)
        second = CoreClient(self.sock)
        self.addCleanup(second.close)
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))
        pilot.stop()
        self.assertTrue(second.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))
```

- [ ] **Step 6: Update the browser test**

In `gateway/e2e/pilot.e2e.js` (change 1 of 2), replace:

```js
const procs = [];
const ARM = 4;
const FAILSAFE = 6;
const HIGH = 1792;
const LOW = 192;
```

with:

```js
const procs = [];
const ARM = 4;
const SENSITIVITY = 6;   // fc_profile aquila20 (the default): CH7 is the drone's sensitivity, kept at S
const HIGH = 1792;
const LOW = 192;
```

In `gateway/e2e/pilot.e2e.js` (change 2 of 2), replace:

```js
  });
  await waitFor(() => channels[ARM] === HIGH, 3000, 'ARM channel high');
  assert.equal(channels[FAILSAFE], LOW, 'FAILSAFE must be low while flying');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'ARMADO'"), 3000, 'ARMADO on the page');

  // dead-man: the page loses focus -> it stops sending -> crsf-core fails safe
  const t0 = Date.now();
  await page.evaluate("document.hasFocus = () => false; window.dispatchEvent(new Event('blur'))");
  await waitFor(() => channels[FAILSAFE] === HIGH, 3000, 'FAILSAFE channel high');
  assert.ok(Date.now() - t0 < 1000, `failsafe took ${Date.now() - t0} ms`);
  await waitFor(() => page.evaluate("!document.getElementById('banner').hidden"), 3000, 'failsafe banner');
```

with:

```js
  });
  await waitFor(() => channels[ARM] === HIGH, 3000, 'ARM channel high');
  assert.equal(channels[SENSITIVITY], LOW, 'sensitivity must stay at S');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'ARMADO'"), 3000, 'ARMADO on the page');

  // dead-man: the page loses focus -> it stops sending -> crsf-core fails safe, which on the
  // Aquila20 means ARM low (the drone disarms) while the link keeps running
  const t0 = Date.now();
  await page.evaluate("document.hasFocus = () => false; window.dispatchEvent(new Event('blur'))");
  await waitFor(() => channels[ARM] === LOW, 3000, 'ARM channel low (failsafe disarm)');
  assert.equal(channels[SENSITIVITY], LOW, 'sensitivity still S during failsafe');
  assert.ok(Date.now() - t0 < 1000, `failsafe took ${Date.now() - t0} ms`);
  await waitFor(() => page.evaluate("!document.getElementById('banner').hidden"), 3000, 'failsafe banner');
```

- [ ] **Step 7: Run everything to see it pass**

Run: `make -C core integration && make -C core && npm --prefix gateway run e2e`

Expected: PASS: `Ran 26 tests` … `OK`; browser `ok 1 - control buttons stay out of the cockpit…`, `ok 2 - pilot page arms the aircraft and fails safe when the page loses control`, `ok 3 - watch.html plays…`, `# pass 3`. (Let the Pi cool first if `vcgencmd measure_temp` is above 70 °C.)

- [ ] **Step 8: Commit**

```bash
git add core/src/chmap.c core/src/chmap.h core/tests/test_chmap.c core/tests/integration/test_core.py gateway/e2e/pilot.e2e.js
git commit -m "core: aquila20 failsafe drops ARM over a live link"
```

### Task 3: Flight-mode text is read as "armed" only for Betaflight

**Files:**
- Modify: `core/src/rtloop.c`
- Test: `core/tests/integration/test_core.py`

**Interfaces:**
- Consumes: `config_t.fc_profile` (Task 1), the Task 2 harness
- Produces: in `aquila20`, `safety_fc_flight_mode()` is never called: the status `fc_arm` stays 0 (unknown) and ack is never refused with `fc_still_armed`; the text is still forwarded and logged

- [ ] **Step 1: Write the failing integration test**

In `core/tests/integration/test_core.py`, replace:

```python
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_arm_refused_with_throttle_up(self):
        pilot = Pilot(self.client, session=14, throttle=400)
```

with:

```python
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_flight_mode_text_never_blocks_clearing_failsafe(self):
        # The Aquila20's flight-mode text ("S-NORMAL") never says whether it is armed. Read the
        # Betaflight way (no '*' = armed) it would refuse every ack.
        pilot = Pilot(self.client, session=15)
        self.arm(pilot)
        self.tx.flight_mode = "S-NORMAL"
        time.sleep(0.3)                                    # telemetry reaches the core
        self.client.send(FAILSAFE, 15)
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on))
        self.client.send(ACK, 15)
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "DISARMED"))
        self.assertNotIn(("ack_refused", "fc_still_armed", 15), self.client.events)
        pilot.stop()

    def test_arm_refused_with_throttle_up(self):
        pilot = Pilot(self.client, session=14, throttle=400)
```

- [ ] **Step 2: Run the integration tests to see it fail**

Run: `make -C core integration`

Expected: FAIL: `test_flight_mode_text_never_blocks_clearing_failsafe` with `AssertionError: False is not true` (the ack was refused), then `Ran 27 tests` and `FAILED (failures=1)`

- [ ] **Step 3: Feed the FC-armed check only in the betaflight profile**

In `core/src/rtloop.c`, replace:

```c
        break;
    case CRSF_MSG_FLIGHT_MODE:
        safety_fc_flight_mode(&l->safety, m.u.flight_mode.mode, l->now_ns);
        if (strcmp(l->flight_mode, m.u.flight_mode.mode) != 0) {
            snprintf(l->flight_mode, sizeof l->flight_mode, "%s", m.u.flight_mode.mode);
```

with:

```c
        break;
    case CRSF_MSG_FLIGHT_MODE:
        /* Only Betaflight's text says whether it is armed ('*' = disarmed). The Aquila20's
         * ("S-NORMAL") never does: it is forwarded and logged, never read as "armed". */
        if (l->cfg->fc_profile == FC_PROFILE_BETAFLIGHT)
            safety_fc_flight_mode(&l->safety, m.u.flight_mode.mode, l->now_ns);
        if (strcmp(l->flight_mode, m.u.flight_mode.mode) != 0) {
            snprintf(l->flight_mode, sizeof l->flight_mode, "%s", m.u.flight_mode.mode);
```

- [ ] **Step 4: Run the integration tests**

Run: `make -C core && make -C core integration`

Expected: the new test passes, and `test_link_battery_and_flight_mode_are_forwarded` now FAILs: it asserts the Betaflight reading of `ACRO*` (`fc_arm == 1`), which the aquila20 default no longer makes. `Ran 27 tests`, `FAILED (failures=1)`

- [ ] **Step 5: Split that check per profile**

Under `aquila20` the status must report the armed state as unknown (0); the `*` → disarmed reading moves into `BetaflightTest`.

In `core/tests/integration/test_core.py` (change 1 of 2), replace:

```python


class ResilienceTest(CoreHarness):
    def test_unplugged_module_is_reported(self):
```

with:

```python


    def test_flight_mode_star_means_disarmed(self):
        self.tx.flight_mode = "ACRO*"
        self.assertTrue(self.client.wait(lambda c: c.flight_mode == "ACRO*", timeout=3))
        self.assertTrue(self.client.wait(lambda c: c.status["fc_arm"] == 1))   # FC_DISARMED


class ResilienceTest(CoreHarness):
    def test_unplugged_module_is_reported(self):
```

In `core/tests/integration/test_core.py` (change 2 of 2), replace:

```python
        self.assertEqual(self.client.link["up_rssi1"], -67)
        self.assertEqual(self.client.battery["voltage_dv"], 151)
        self.assertEqual(self.client.status["fc_arm"], 1)   # FC_DISARMED


```

with:

```python
        self.assertEqual(self.client.link["up_rssi1"], -67)
        self.assertEqual(self.client.battery["voltage_dv"], 151)
        self.assertEqual(self.client.status["fc_arm"], 0)   # aquila20: armed state unknown


```

- [ ] **Step 6: Run all core tests to see them pass**

Run: `make -C core test && make -C core integration`

Expected: PASS: `ALL TESTS PASSED`; integration `Ran 28 tests` … `OK`

- [ ] **Step 7: Commit**

```bash
git add core/src/rtloop.c core/tests/integration/test_core.py
git commit -m "core: aquila20 flight-mode text is never read as armed"
```

### Task 4: Pilot page: N / S / M

**Files:**
- Modify: `web/js/view.js`
- Modify: `web/js/app.js`
- Modify: `web/index.html`
- Test: `web/test/view.test.js`

**Interfaces:**
- Consumes: telemetry `flightMode` text from the gateway (unchanged)
- Produces: `formatFlightMode(text)` in `view.js`: `X-NORMAL` → "N (mantener posición)", `X-SPORT` → "S (estable)", `X-MANUAL` → "M (manual)", anything else unchanged, empty → "—"

- [ ] **Step 1: Write the failing test**

In `web/test/view.test.js` (change 1 of 2), replace:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkTracker, failsafeDetail, formatBattery, formatLink, formatMs, segments, stateLabel } from '../js/view.js';

const goodStatus = { core: true, serialOk: true, timingFrames: 10, state: 'ARMED', reason: 'none' };
```

with:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkTracker, failsafeDetail, formatBattery, formatFlightMode, formatLink, formatMs, segments, stateLabel } from '../js/view.js';

const goodStatus = { core: true, serialOk: true, timingFrames: 10, state: 'ARMED', reason: 'none' };
```

In `web/test/view.test.js` (change 2 of 2), replace:

```js
  assert.equal(formatMs(null), '—');
});
```

with:

```js
  assert.equal(formatMs(null), '—');
});

test('the Aquila20 flight mode is shown in Spanish; other texts as they are', () => {
  // The Aquila20 reports "<sensitivity>-<mode>"; the mode is what the pilot chose (N/S/M).
  assert.equal(formatFlightMode('S-NORMAL'), 'N (mantener posición)');
  assert.equal(formatFlightMode('F-SPORT'), 'S (estable)');
  assert.equal(formatFlightMode('M-MANUAL'), 'M (manual)');
  assert.equal(formatFlightMode('ACRO*'), 'ACRO*');            // e.g. Betaflight
  assert.equal(formatFlightMode(null), '—');
});
```

- [ ] **Step 2: Run the tests to see it fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `SyntaxError: The requested module '../js/view.js' does not provide an export named 'formatFlightMode'`, `not ok … ../web/test/view.test.js`

- [ ] **Step 3: Add the formatter and use it on the page**

In `web/js/view.js`, replace:

```js
export const formatLink = (l) => (l ? `LQ ${l.upLq} % · ${l.upRssi1} dBm · ${l.txPowerMw} mW` : '—');

export const formatMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
```

with:

```js
export const formatLink = (l) => (l ? `LQ ${l.upLq} % · ${l.upRssi1} dBm · ${l.txPowerMw} mW` : '—');

// The Aquila20 reports "<sensitivity>-<mode>" (e.g. "S-NORMAL"); the pilot chose the mode.
const AQUILA_MODES = { NORMAL: 'N (mantener posición)', SPORT: 'S (estable)', MANUAL: 'M (manual)' };

export function formatFlightMode(text) {
  if (!text) return '—';
  const mode = /^[SMF]-(NORMAL|SPORT|MANUAL)$/.exec(text);
  return mode ? AQUILA_MODES[mode[1]] : text;
}

export const formatMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
```

In `web/js/app.js` (change 1 of 2), replace:

```js
import { REFUSAL_TEXT, RATE_HZ, closeAction, connectionTarget, controlMessage, shouldReclaimPilotSeat, tsyncReply } from './protocol.js';
import { StickModel, bindStick, padsMoved, sticksToCommand } from './sticks.js';
import { LinkTracker, failsafeDetail, formatBattery, formatLink, formatMs, segments, stateLabel } from './view.js';
import { keepPlaying } from './whep.js';

```

with:

```js
import { REFUSAL_TEXT, RATE_HZ, closeAction, connectionTarget, controlMessage, shouldReclaimPilotSeat, tsyncReply } from './protocol.js';
import { StickModel, bindStick, padsMoved, sticksToCommand } from './sticks.js';
import { LinkTracker, failsafeDetail, formatBattery, formatFlightMode, formatLink, formatMs, segments, stateLabel } from './view.js';
import { keepPlaying } from './whep.js';

```

In `web/js/app.js` (change 2 of 2), replace:

```js
  $('t-battery').textContent = formatBattery(telem.battery);
  $('t-link').textContent = formatLink(telem.link);
  $('t-mode').textContent = telem.flightMode ?? '—';
  $('t-rtt').textContent = formatMs(status?.rttMs);
  $('t-age').textContent = formatMs(status?.cmdAgeMs);
```

with:

```js
  $('t-battery').textContent = formatBattery(telem.battery);
  $('t-link').textContent = formatLink(telem.link);
  $('t-mode').textContent = formatFlightMode(telem.flightMode);
  $('t-rtt').textContent = formatMs(status?.rttMs);
  $('t-age').textContent = formatMs(status?.cmdAgeMs);
```

In `web/index.html`, replace:

```html
    <button id="btn-failsafe" class="warn">FAILSAFE</button>
    <div class="modes">
      <button data-mode="0" class="on">Modo 1</button>
      <button data-mode="1">Modo 2</button>
      <button data-mode="2">Modo 3</button>
    </div>
  </footer>
```

with:

```html
    <button id="btn-failsafe" class="warn">FAILSAFE</button>
    <div class="modes">
      <button data-mode="0" class="on" title="Mantener posición">N · Posición</button>
      <button data-mode="1" title="Autonivelado">S · Estable</button>
      <button data-mode="2" title="Sin estabilización">M · Manual</button>
    </div>
  </footer>
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm --prefix gateway test && npm --prefix gateway run e2e`

Expected: PASS: `# tests 87`, `# pass 87`, `# fail 0`; browser `# pass 3` (the layout test confirms the longer labels still fit at 640–800 × 360)

- [ ] **Step 5: Commit**

```bash
git add web/js/view.js web/js/app.js web/index.html web/test/view.test.js
git commit -m "web: N/S/M mode buttons and the Aquila20 mode text in Spanish"
```

### Task 5: Documentation

**Files:**
- Create: `docs/setup/aquila20.md`
- Modify: `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md`
- Modify: `docs/HANDOFF.md`

**Interfaces:**
- Consumes: everything above
- Produces: the drone's reference page; the main spec amended (D4, P1, CH7 row); the handoff's blocking decision marked resolved, with what the deferred hardware tasks must adapt

- [ ] **Step 1: Write the drone's reference page**

Create `docs/setup/aquila20.md`:

```markdown
# The drone: BetaFPV Aquila20 HD (fc_profile = aquila20)

The Aquila20's AIO board has an HDSC MCU (USB `0493:5740`) running **BetaFPV's own firmware, not
Betaflight**. The Betaflight Configurator cannot connect to it: it does not answer MSP or the CLI.
Its receiver is built in ("BFPV AIO 2G4RX", ExpressLRS 3.5.6). crsf-core drives it with
`fc_profile = aquila20` (the default; `deploy/crsf-core.conf` sets it explicitly).

## 1. Channels (measured 2026-10-07, propellers off)

| Channel | Function | Values |
|---------|----------|--------|
| CH1–CH4 | roll, pitch, throttle, yaw | 1000–2000 µs |
| **CH5** | **ARM** (high = armed, motors spin) | 1000 / 2000 µs |
| CH6 | flight mode: low `NORMAL` (N, position hold), mid `SPORT` (S, self-levelling), high `MANUAL` (M) | 1000 / 1500 / 2000 µs |
| CH7 | stick sensitivity: low `S`, mid `M`, high `F`. **crsf-core keeps it low (S)** | 1000 µs |
| CH8 | no visible effect | — |

Flight-mode telemetry reads `<sensitivity>-<mode>`, for example `S-NORMAL`. **It never says
whether the drone is armed.** The pilot page shows it as "N (mantener posición)", "S (estable)"
or "M (manual)".

## 2. Failsafe behaviour

- **crsf-core's FAILSAFE** drops CH5 (ARM) low, centres the sticks and puts the throttle at
  minimum, **while keeping the link up**. The motors stop and telemetry keeps flowing. In flight
  the drone drops, because it has no landing procedure.
- **Link lost while armed** (the Pi, crsf-core or the module goes silent): the drone's own
  failsafe stops the motors **at once** (measured).
- **Link back with CH5 still high:** the drone stays disarmed. The arm switch must be cycled.
- Clearing a failsafe in crsf-core needs the pilot's session, a fresh link and the throttle low.
  It ends disarmed, and flying again needs a new arm. There is no "FC still armed" check: the
  drone does not report it, and the failsafe has already disarmed it.

## 3. Bench checks (replace `betaflight.md` for this drone)

Do these with **propellers off**, the TX module on its XT30 supply, and the drone on its battery.

1. Bind (once): see `docs/setup/module.md` §4.
2. `./core/build/crsf-probe --rc -t 5 /dev/ttyUSB0`: you should see a `link:` line with LQ near
   100 %, `flight mode: S-NORMAL`, and `device 0xEC: "BFPV AIO 2G4RX"`.
3. With crsf-core running and `crsf-ctl pilot`: press `a` (arm). The motors spin. Press `f`
   (failsafe). The motors stop at once, CH5 goes low, and `crsf-ctl status` starts
   with `FAILSAFE reason=manual`. Press `k` (ack): the state goes back to `DISARMED`.
4. Mode switch: from the pilot page, N / S / M should show "N (mantener posición)", "S (estable)"
   and "M (manual)" in the telemetry line.

## 4. Not yet known

- Whether the Aquila20 itself refuses to arm with the throttle up. crsf-core refuses that anyway
  (`throttle_arm_max`).
- The settings in the BETAFPV Configurator (PC only). Record any failsafe or arming options here
  when a teammate connects it.
```

- [ ] **Step 2: Amend the main spec**

In `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (change 1 of 3), replace:

```markdown
**Status:** draft for team review. Section 2 says which decisions the team made and which
were proposed while writing the plans and still need confirmation.

## 1. Goal
```

with:

```markdown
**Status:** draft for team review. Section 2 says which decisions the team made and which
were proposed while writing the plans and still need confirmation.

> **Amendment 2026-10-07:** the project drone is a BetaFPV Aquila20 HD running BetaFPV's own
> firmware, not Betaflight. `crsf-core` gained `fc_profile = aquila20 | betaflight` (default
> `aquila20`). Where this document describes Betaflight-specific behaviour (FAILSAFE switch on
> CH7, the `*` disarmed marker, `!FS!` confirmation, Betaflight setup), it now applies to the
> `betaflight` profile only. For the Aquila20, see `2026-10-07-aquila20-profile-design.md` and
> `docs/setup/aquila20.md`.

## 1. Goal
```

In `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (change 2 of 3), replace:

```markdown
| D2 | **Write the bridge from scratch**; `elrs-joystick-control` is a protocol reference only | Byte layouts were checked against the reference (identical RC frames) and against EdgeTX's conventions. |
| D3 | Real-time core in **C** | gcc 14 + make on the Pi; no extra toolchain. |
| D4 | Flight controller firmware: **Betaflight** | Failsafe = Betaflight's FAILSAFE mode on an AUX switch; flight-mode telemetry confirms it. |
| D5 | **Two processes: C core + Node.js gateway** over a Unix socket | Matches the Gantt (WebSocket server is the web developer's task). Gateway crashes fail safe. HTTPS/relay stay out of C. |

**Proposed while writing the plans; please confirm or change:**

| # | Proposal | Why | Where to change it |
|---|----------|-----|--------------------|
| P1 | Failsafe action = raise **FAILSAFE (CH7/AUX3)**, centre sticks, throttle low, **keep ARM** as it is; Betaflight `failsafe_switch_mode = STAGE2` runs its procedure | Betaflight's procedure (drop / land / GPS rescue) is tested and configurable; the bridge only has to detect the loss quickly | `safety.c`, `docs/setup/betaflight.md` |
| P2 | Command timeout **300 ms**; gateway drops commands older than **200 ms** | Leaves > 600 ms of the 1 s budget for propagation; tolerates normal Wi-Fi hiccups (FMEA #5) | `cmd_timeout_ms`, `maxCommandAgeMs` |
| P3 | Failsafe is **latched**. Clearing needs an explicit hold-to-confirm, a fresh link, throttle low, and the FC **not** reporting itself armed (Betaflight's `*` flight-mode suffix). Clearing always ends disarmed; flying again needs a new arm. | FMEA #14 (no revival of old commands); stops the pilot from disarming a drone mid-landing by accident | `safety_ack()` |
```

with:

```markdown
| D2 | **Write the bridge from scratch**; `elrs-joystick-control` is a protocol reference only | Byte layouts were checked against the reference (identical RC frames) and against EdgeTX's conventions. |
| D3 | Real-time core in **C** | gcc 14 + make on the Pi; no extra toolchain. |
| D4 | Flight controller: **BetaFPV Aquila20 HD, BetaFPV's own firmware** (amended 2026-10-07; was Betaflight). Betaflight is kept as a profile (`fc_profile`). | Aquila20: FAILSAFE drops ARM over a live link; armed state is not in telemetry. See `2026-10-07-aquila20-profile-design.md`. |
| D5 | **Two processes: C core + Node.js gateway** over a Unix socket | Matches the Gantt (WebSocket server is the web developer's task). Gateway crashes fail safe. HTTPS/relay stay out of C. |

**Proposed while writing the plans; please confirm or change:**

| # | Proposal | Why | Where to change it |
|---|----------|-----|--------------------|
| P1 | Failsafe action, **`betaflight` profile**: raise **FAILSAFE (CH7/AUX3)**, centre sticks, throttle low, **keep ARM** as it is; Betaflight `failsafe_switch_mode = STAGE2` runs its procedure. **`aquila20` profile (default): ARM low**, sticks centred, throttle low, link kept up | Betaflight's procedure (drop / land / GPS rescue) is tested and configurable; the bridge only has to detect the loss quickly | `safety.c`, `docs/setup/betaflight.md` |
| P2 | Command timeout **300 ms**; gateway drops commands older than **200 ms** | Leaves > 600 ms of the 1 s budget for propagation; tolerates normal Wi-Fi hiccups (FMEA #5) | `cmd_timeout_ms`, `maxCommandAgeMs` |
| P3 | Failsafe is **latched**. Clearing needs an explicit hold-to-confirm, a fresh link, throttle low, and the FC **not** reporting itself armed (Betaflight's `*` flight-mode suffix). Clearing always ends disarmed; flying again needs a new arm. | FMEA #14 (no revival of old commands); stops the pilot from disarming a drone mid-landing by accident | `safety_ack()` |
```

In `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (change 3 of 3), replace:

```markdown
| CH5 AUX1 | ARM (ELRS sends AUX1 every packet; enforced) | 1000 / 2000 µs |
| CH6 AUX2 | flight-mode switch | 1000 / 1500 / 2000 µs |
| CH7 AUX3 | FAILSAFE (Betaflight mode) | 1000 / 2000 µs |
| CH8–CH16 | unused | 1000 µs |

```

with:

```markdown
| CH5 AUX1 | ARM (ELRS sends AUX1 every packet; enforced) | 1000 / 2000 µs |
| CH6 AUX2 | flight-mode switch | 1000 / 1500 / 2000 µs |
| CH7 AUX3 | `betaflight`: FAILSAFE (Betaflight mode). `aquila20`: the drone's stick sensitivity, always 1000 µs (S) | 1000 / 2000 µs |
| CH8–CH16 | unused | 1000 µs |

```

- [ ] **Step 3: Update the handoff**

In `docs/HANDOFF.md`, replace:

```markdown
## 6. Open items for the team

- **BLOCKING DECISION (found 2026-10-07): the drone does not run Betaflight.**
  - **The hardware:** the Aquila20 HD kit's AIO board has an HDSC MCU (USB 0493:5740) running
    BetaFPV's own simplified firmware. It is configured only with the BETAFPV Configurator
    and does not answer MSP or the CLI. Its built-in receiver is "BFPV AIO 2G4RX",
    ExpressLRS 3.5.6.
  - **What breaks:** decision D4 and every Betaflight-specific part of the design:
    - the FAILSAFE AUX switch (CH7 → Betaflight FAILSAFE mode);
    - the "FC armed" check, which treats a flight mode without a trailing `*` as armed. This
      drone reports `S-NORMAL`, so `safety.c` would see it as permanently armed and refuse
      every failsafe clear (`fc_still_armed`);
    - the C3 FC confirmation (`!FS!`);
    - M3 Task 8's Betaflight setup.
  - **Options:**
    - (a) Use a Betaflight drone or flight controller instead.
    - (b) Keep the Aquila20 and redesign failsafe around its own behaviour on RC loss. For
      example, `crsf-core` stops sending RC frames on FAILSAFE so the receiver's failsafe takes
      over. That needs its arming channel, mode strings and failsafe behaviour measured first.
  - Decide this before M3 Task 8.

- Confirm proposals P1–P11 (spec §2) and the C1 limits (p99 ≤ 250 µs, max ≤ 1 ms) with the mentor.
```

with:

```markdown
## 6. Open items for the team

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
```

- [ ] **Step 4: Run every suite once more**

Run: `make -C core test && make -C core integration && npm --prefix gateway test && npm --prefix relay test`

Expected: PASS: `ALL TESTS PASSED`, `Ran 28 tests` … `OK`, `# pass 87`, relay `# pass 11`

- [ ] **Step 5: Commit**

```bash
git add docs/setup/aquila20.md docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md docs/HANDOFF.md
git commit -m "docs: Aquila20 reference page, spec amendment, handoff"
```

## Done when

- All suites pass: `make -C core test` and `make -C core integration` (28), `npm --prefix gateway test` (87),
  `npm --prefix relay test` (11), `npm --prefix gateway run e2e` (3).
- `deploy/crsf-core.conf` says `fc_profile = aquila20`.
- On the bench (later, M3 Task 8 with `docs/setup/aquila20.md` §3): crsf-core's FAILSAFE stops the motors at once
  and CH7 never moves.
