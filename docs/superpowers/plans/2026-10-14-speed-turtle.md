# Speed (CH7) and Turtle Mode (CH8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pilot page gets Slow / Mid / Fast buttons (Aquila20 CH7) and a Turtle on/off button (CH8), carried in every control message and put on the air by crsf-core.

**Architecture:**
- **Path:** speed and turtle follow the flight mode's path. The page adds `sp`/`tu` to each `ctl` message; the gateway range-checks them and appends two bytes to the binary CONTROL message; the core's safety layer clamps them; the channel map puts them on CH7/CH8 (Aquila20 profile only).
- **FAILSAFE** forces turtle off and keeps the speed.

**Tech Stack:**
- C (gcc 14, make; check.h unit tests, Python integration tests against the real binary);
- Node 22 gateway (node:test);
- plain ES-module web page (node:test, headless-Firefox e2e).

**Spec:** `docs/superpowers/specs/2026-10-14-speed-turtle-design.md`

## Global Constraints

- **Speed:** 0..2 = Slow / Mid / Fast → CH7 at 1000 / 1500 / 2000 µs. Default 0 (Slow).
- **Turtle:** 0/1 → CH8 at 1000 / 2000 µs. Default 0 (off).
- **Profiles:** both functions exist only in `fc_profile = aquila20`. In `betaflight`, CH7 stays the FAILSAFE switch (`ch_failsafe`) and CH8 is unused.
- **FAILSAFE:** turtle output is forced off; speed keeps its last value; sticks centred, ARM low (unchanged).
- **Changes at any time,** armed or not, like the physical switches.
- **Wire names:** `ctl` fields `sp` (0..2) and `tu` (0|1). CONTROL payload = the old 17 bytes + `u8 speed, u8 turtle` = **19 bytes**.
- **Defaults when absent:**
  - the gateway treats a missing `sp`/`tu` as 0;
  - the core accepts a 17-byte CONTROL as speed 0, turtle 0. The gateway and core may be restarted at different times.
- **Page:**
  - starts at Slow, turtle off;
  - turtle goes off after a failsafe and on an input-mode change; speed is kept.
- **Keys:** T toggles turtle; 4/5/6 (and Numpad4/5/6) choose Slow/Mid/Fast; not while typing a value.
- **Commits:** on the branch `feat/speed-turtle`. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FH2h7uPkhHvWtbotLYWPsQ
  ```
- **Before calling the work done, run all five suites** (`docs/HANDOFF.md` §5). Browser tests run one at a time; check `vcgencmd measure_temp` first.

## Review Focus

1. **A gateway restarted before the core (or the reverse):** a 19-byte CONTROL to an old core, or a 17-byte one to a new core. The new core must accept both (Task 1 tests the 17-byte decode).
2. **An older page without `sp`/`tu`** (a cached tab): its commands must still reach the core, as Slow and turtle off (Task 3).
3. **Turtle left on when the pilot loses control:** the page stops sending, the core fails safe, and CH8 must drop even though the last command had `tu: 1` (Tasks 1 and 2: safety and chmap both force it).
4. **Out-of-range values** (`sp: 3`, `tu: 2`, non-integers): the gateway drops the message, as for `m: 3`; the core clamps anything that gets through (Tasks 1 and 3).
5. **Holding T:** the key's auto-repeat must not toggle turtle on and off 30 times a second. Only a fresh press toggles (Task 4).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `core/src/safety.h`, `safety.c` | modify | `stick_cmd_t` gains `speed`, `turtle`; clamping; FAILSAFE forces turtle off |
| `core/src/chmap.h`, `chmap.c` | modify | `rc_outputs_t` gains `speed`, `turtle`; CH7/CH8 levels (aquila20) |
| `core/src/ipc_proto.h`, `ipc_proto.c` | modify | CONTROL is 19 bytes; 17 still decoded |
| `core/src/config.h`, `config.c` | modify | `ch_speed`, `ch_turtle`; per-profile channel validation |
| `core/src/mailbox.h`, `evlog.c`, `rtloop.c` | modify | the stick log carries speed and turtle |
| `core/tests/*` | modify | unit and integration tests |
| `gateway/src/hub.js`, `ipc.js` | modify | `sp`/`tu` checks and defaults; 19-byte CONTROL |
| `web/js/switches.js` | **create** | pure model: speed, turtle, keys, what goes on the wire |
| `web/js/protocol.js`, `view.js` | modify | `controlMessage(…, sw)`; "Normal · Slow" / "TURTLE" |
| `web/js/app.js`, `web/index.html`, `web/css/app.css` | modify | buttons, keys, rendering, resets |
| docs | modify | `aquila20.md`, `ARCHITECTURE.md`, the Aquila20 spec, HANDOFF |

---

### Task 1: Core: speed and turtle in the command, the safety rules and the CONTROL message

**Files:**
- Modify: `core/src/safety.h:44-48`, `core/src/safety.c:10-29` and `:61-65`
- Modify: `core/src/chmap.h:10-16`
- Modify: `core/src/ipc_proto.h:18`, `core/src/ipc_proto.c:112-123` and `:211-224`
- Test: `core/tests/test_safety.c`, `core/tests/test_ipc_proto.c`

**Interfaces:**
- Produces:
  - `stick_cmd_t { int16_t roll, pitch, yaw; uint16_t throttle; uint8_t mode; uint8_t speed; bool turtle; }`;
  - `rc_outputs_t` with `uint8_t speed; bool turtle;` after `mode`;
  - `ipc_decode_control()` accepts 17 or 19 bytes;
  - `ipc_encode_control()` writes 19.

- [ ] **Step 1: Write the failing tests**

In `core/tests/test_safety.c`, add before `int main(void)`:

```c
static void test_speed_and_turtle_follow_the_command_and_are_clamped(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    stick_cmd_t c = { .speed = 2, .turtle = true };
    CHECK(safety_control(&s, 7, 1, &c, 0));
    CHECK_EQ_INT(s.out.speed, 2);
    CHECK(s.out.turtle);
    c.speed = 9;                                   /* garbage from a buggy client */
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    CHECK_EQ_INT(s.out.speed, 2);
}

static void test_failsafe_forces_turtle_off_and_keeps_speed(void)
{
    /* Spec §3.4: like the sticks, turtle must not stay on once the core has lost the pilot. */
    safety_t s;
    armed(&s);
    stick_cmd_t c = { .speed = 1, .turtle = true };
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    CHECK(s.out.turtle);
    safety_tick(&s, 400 * MS);                     /* no fresh command for 390 ms */
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK(!s.out.turtle);
    CHECK_EQ_INT(s.out.speed, 1);
    CHECK(safety_control(&s, 7, 3, &c, 410 * MS)); /* commands in FAILSAFE change nothing */
    CHECK(!s.out.turtle);
}
```

Add to `main()`, after the last `RUN(...)`:

```c
    RUN(test_speed_and_turtle_follow_the_command_and_are_clamped);
    RUN(test_failsafe_forces_turtle_off_and_keeps_speed);
```

In `core/tests/test_ipc_proto.c`, replace `CONTROL_GOLDEN` and `test_control_golden_bytes` with:

```c
/* Shared with gateway/test/ipc.test.js: both implementations must produce/accept these. */
static const uint8_t CONTROL_GOLDEN[] = {
    0x14, 0x00, 0x02, 0x04, 0x03, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00,
    0x18, 0xFC, 0xFA, 0x00, 0x00, 0x00, 0xE8, 0x03, 0x02, 0x02, 0x01,
};
```

```c
static void test_control_golden_bytes(void)
{
    ipc_control_t c = { .session = 0x01020304, .seq = 5,
                        .sticks = { .roll = -1000, .pitch = 250, .yaw = 0, .throttle = 1000, .mode = 2,
                                    .speed = 2, .turtle = true } };
    uint8_t buf[64];
    CHECK_EQ_INT(ipc_encode_control(buf, sizeof buf, &c), sizeof CONTROL_GOLDEN);
    CHECK_MEM(buf, CONTROL_GOLDEN, sizeof CONTROL_GOLDEN);

    ipc_control_t d;
    CHECK_EQ_INT(ipc_decode_control(CONTROL_GOLDEN + 3, sizeof CONTROL_GOLDEN - 3, &d), 0);
    CHECK_EQ_INT(d.session, 0x01020304);
    CHECK_EQ_INT(d.seq, 5);
    CHECK_EQ_INT(d.sticks.roll, -1000);
    CHECK_EQ_INT(d.sticks.pitch, 250);
    CHECK_EQ_INT(d.sticks.throttle, 1000);
    CHECK_EQ_INT(d.sticks.mode, 2);
    CHECK_EQ_INT(d.sticks.speed, 2);
    CHECK(d.sticks.turtle);
}

static void test_control_from_an_older_gateway_is_still_accepted(void)
{
    /* 17 bytes, no speed/turtle: a gateway not yet restarted after an update. */
    ipc_control_t d;
    CHECK_EQ_INT(ipc_decode_control(CONTROL_GOLDEN + 3, 17, &d), 0);
    CHECK_EQ_INT(d.sticks.mode, 2);
    CHECK_EQ_INT(d.sticks.speed, 0);
    CHECK(!d.sticks.turtle);
    CHECK_EQ_INT(ipc_decode_control(CONTROL_GOLDEN + 3, 18, &d), -1);
}
```

In the same file, in the reader test, change `CHECK_EQ_INT(g.plen, 17);` to `CHECK_EQ_INT(g.plen, 19);`. Add `RUN(test_control_from_an_older_gateway_is_still_accepted);` after `RUN(test_control_golden_bytes);`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `make -s -C core test 2>&1 | grep -E "error|FAIL|PASSED" | head`
Expected: compile errors `‘stick_cmd_t’ has no member named ‘speed’`.

- [ ] **Step 3: Implement**

`core/src/safety.h`, replace the `stick_cmd_t` typedef:

```c
typedef struct {
    int16_t roll, pitch, yaw;  /* -1000..1000 */
    uint16_t throttle;         /* 0..1000 */
    uint8_t mode;              /* 0..2 */
    uint8_t speed;             /* 0..2 (aquila20 CH7: Slow, Mid, Fast) */
    bool turtle;               /* aquila20 CH8 */
} stick_cmd_t;
```

`core/src/chmap.h`, in `rc_outputs_t` after `uint8_t mode;`:

```c
    uint8_t speed;             /* aquila20: CH7 position 0..2 (Slow, Mid, Fast) */
    bool turtle;               /* aquila20: CH8 high */
```

`core/src/safety.c`:
- In `apply_sticks()`, after `s->out.mode = s->cmd.mode;`:
  ```c
      s->out.speed = s->cmd.speed;
      s->out.turtle = s->cmd.turtle;
  ```
- In `enter_failsafe()`, after `s->out.throttle = 0;`:
  ```c
      s->out.turtle = false;     /* speed is kept: it only changes how the drone responds */
  ```
- In `safety_control()`, after the `s->cmd.mode = …` line:
  ```c
      s->cmd.speed = (uint8_t)clampi(cmd->speed, 0, 2);
      s->cmd.turtle = cmd->turtle;
  ```

`core/src/ipc_proto.h`, line 18:

```c
#define IPC_CONTROL     0x02  /* u32 session, u32 seq, i16 roll, i16 pitch, i16 yaw, u16 throttle, u8 mode,
                                 u8 speed, u8 turtle (19 bytes; 17 = older gateway: speed 0, turtle off) */
```

`core/src/ipc_proto.c`:
- In `ipc_encode_control()`, after `put_u8(&w, c->sticks.mode);`:
  ```c
      put_u8(&w, c->sticks.speed);
      put_u8(&w, c->sticks.turtle ? 1 : 0);
  ```
- Replace `ipc_decode_control()` with:
  ```c
  int ipc_decode_control(const uint8_t *p, size_t n, ipc_control_t *c)
  {
      if (n != 17 && n != 19)
          return -1;
      rbuf_t r = { .p = p, .len = n };
      c->session = get_u32(&r);
      c->seq = get_u32(&r);
      c->sticks.roll = (int16_t)get_u16(&r);
      c->sticks.pitch = (int16_t)get_u16(&r);
      c->sticks.yaw = (int16_t)get_u16(&r);
      c->sticks.throttle = get_u16(&r);
      c->sticks.mode = get_u8(&r);
      c->sticks.speed = n == 19 ? get_u8(&r) : 0;
      c->sticks.turtle = n == 19 ? get_u8(&r) != 0 : false;
      return 0;
  }
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make -s -C core test 2>&1 | tail -1 && make -s -C core integration 2>&1 | grep -E "^(Ran|OK|FAILED)"`
Expected: `ALL TESTS PASSED`; integration `OK`. The Python client still sends 17-byte CONTROL, which stays accepted.

- [ ] **Step 5: Commit**

```bash
git add core/src/safety.h core/src/safety.c core/src/chmap.h core/src/ipc_proto.h core/src/ipc_proto.c \
        core/tests/test_safety.c core/tests/test_ipc_proto.c
git commit -m "core: speed and turtle travel in the command; FAILSAFE forces turtle off"   # + trailer
```

---

### Task 2: Core: CH7/CH8 on the air, channel validation, and the stick log

**Files:**
- Modify: `core/src/config.h:20,47`, `core/src/config.c` (defaults, the `channels[]` key table, validation at `:188-200`)
- Modify: `core/src/chmap.c:34-39`
- Modify: `core/src/mailbox.h` (`core_event_t`), `core/src/evlog.c` (`EV_STICKS` case), `core/src/rtloop.c` (`log_sticks`)
- Modify: `deploy/crsf-core.conf` (channel layout comment and keys)
- Test: `core/tests/test_config.c`, `core/tests/test_chmap.c`, `core/tests/test_evlog.c`, `core/tests/integration/core_client.py`, `core/tests/integration/test_core.py`

**Interfaces:**
- Consumes: `rc_outputs_t.speed`, `.turtle` (Task 1).
- Produces:
  - config fields `int ch_speed, ch_turtle;` (0-based; defaults 6 and 7; keys `ch_speed`, `ch_turtle`, 1-based in the file);
  - `core_event_t` gains `int32_t g, h;`;
  - the `sticks` log line gains `"speed":N,"turtle":true|false`;
  - Python `CoreClient.control(…, speed=0, turtle=0)` sends 19 bytes, and `Pilot` has attributes `speed`, `turtle`.

- [ ] **Step 1: Write the failing tests**

`core/tests/test_config.c`, replace `test_aquila20_keeps_ch7_for_its_sensitivity_switch` with the test below, and rename it in `main()`:

```c
static void test_aquila20_reserves_ch7_and_ch8_for_speed_and_turtle(void)
{
    /* Aquila20: CH7 = speed (SC), CH8 = turtle (SD). No stick or switch may share them;
     * ch_failsafe is not used, so it may point anywhere. Betaflight: CH7 is the FAILSAFE
     * switch and speed/turtle are unused. */
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(c.ch_speed, 6);
    CHECK_EQ_INT(c.ch_turtle, 7);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "ch_yaw", "7", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "8", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_failsafe", "4", err, sizeof err), 0);   /* unused in aquila20 */
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "betaflight", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);                /* betaflight uses it */
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "betaflight", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);   /* ch_failsafe = ch_speed = CH7: fine */
    CHECK_EQ_INT(config_set(&c, "ch_turtle", "17", err, sizeof err), -1); /* 1..16 at parse time */
}
```

`core/tests/test_chmap.c`, add before `int main(void)`:

```c
static void test_aquila20_speed_on_ch7_and_turtle_on_ch8(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { .speed = 0 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    for (int sp = 0; sp <= 2; sp++) {
        o.speed = (uint8_t)sp;
        chmap_build(&c, &o, ch);
        CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 1000 + sp * 500);
    }
    CHECK_EQ_INT(crsf_ch_to_us(ch[7]), 1000);
    o.turtle = true;
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[7]), 2000);
    o.failsafe = true;                               /* defence in depth: FAILSAFE drops turtle */
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[7]), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 2000);        /* speed kept */
    o.speed = 7;                                     /* clamped */
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 2000);
}

static void test_betaflight_ignores_speed_and_turtle(void)
{
    config_t c;
    config_defaults(&c);
    c.fc_profile = FC_PROFILE_BETAFLIGHT;
    rc_outputs_t o = { .speed = 2, .turtle = true };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 1000);        /* the FAILSAFE switch, off */
    CHECK_EQ_INT(crsf_ch_to_us(ch[7]), 1000);
}
```

Add both to `main()`:

```c
    RUN(test_aquila20_speed_on_ch7_and_turtle_on_ch8);
    RUN(test_betaflight_ignores_speed_and_turtle);
```

`core/tests/test_evlog.c`, in `test_sticks_event`:
- add `.g = 2, .h = 1,` to the event initialiser;
- change the expected string's tail from `"\"mode\":0,\"arm\":true,\"cmd_age_ms\":14}"` to `"\"mode\":0,\"speed\":2,\"turtle\":true,\"arm\":true,\"cmd_age_ms\":14}"`.

`core/tests/integration/core_client.py`: replace `control()`, and make `Pilot` send speed and turtle.

```python
    def control(self, session, seq, roll=0, pitch=0, yaw=0, throttle=0, mode=0, speed=0, turtle=0):
        self.sock.sendall(msg(CONTROL, struct.pack("<IIhhhHBBB", session, seq, roll, pitch, yaw, throttle, mode,
                                                   speed, turtle)))
```

In `Pilot.__init__`, after `self.throttle = throttle`, add `self.speed = 0` and `self.turtle = 0`. In `Pilot._run`, change the control call to:

```python
                    self.client.control(self.session, self.seq, throttle=self.throttle,
                                        speed=self.speed, turtle=self.turtle)
```

`core/tests/integration/test_core.py`:
- next to `CH_ARM, CH_FAILSAFE, CH_THROTTLE`, add `CH_SPEED, CH_TURTLE = 6, 7`;
- add to `StickLogTest`:

```python
    def test_speed_and_turtle_reach_ch7_and_ch8_and_failsafe_drops_turtle(self):
        pilot = Pilot(self.client, session=19)
        self.arm(pilot)
        pilot.speed, pilot.turtle = 2, 1
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_SPEED] == HIGH and ch[CH_TURTLE] == HIGH),
                             "speed/turtle never reached CH7/CH8")
        pilot.paused = True                                # the page stops sending
        self.assertTrue(self.client.wait(lambda c: c.status["reason_name"] == "cmd_timeout", timeout=2))
        ch = self.tx.last_channels()
        self.assertEqual((ch[CH_ARM], ch[CH_TURTLE], ch[CH_SPEED]), (LOW, LOW, HIGH))
        pilot.stop()
        sticks = [e for e in self.read_events() if e["ev"] == "sticks"]
        self.assertTrue(any(e["speed"] == 2 and e["turtle"] for e in sticks))
        self.assertFalse(sticks[-1]["turtle"])             # the line after FAILSAFE
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `make -s -C core test 2>&1 | grep -E "error" | head -3`
Expected: `‘config_t’ has no member named ‘ch_speed’`.

- [ ] **Step 3: Implement**

`core/src/config.h`:
- delete `#define AQUILA20_SENSITIVITY_CH 6`;
- replace the `ch_…` line in `config_t` with:
  ```c
      int ch_roll, ch_pitch, ch_throttle, ch_yaw, ch_arm, ch_mode, ch_failsafe;
      int ch_speed, ch_turtle;           /* aquila20 only: CH7 speed (Slow/Mid/Fast), CH8 turtle */
  ```
- in the header comment on the AQUILA20 profile, change "CH7 is the drone's stick-sensitivity switch and stays low (S)" to "CH7 is the drone's speed switch (Slow/Mid/Fast) and CH8 its turtle mode, both set by the pilot".

`core/src/config.c`:
- in `config_defaults()`, after `c->ch_failsafe = 6;`:
  ```c
      c->ch_speed = 6;     /* CH7 = AUX3 (aquila20: speed) */
      c->ch_turtle = 7;    /* CH8 = AUX4 (aquila20: turtle) */
  ```
- in the `channels[]` key table, after `ch_failsafe`:
  ```c
          { "ch_speed", offsetof(config_t, ch_speed) },
          { "ch_turtle", offsetof(config_t, ch_turtle) },
  ```
- in `config_validate()`, replace everything from the comment `/* ch_failsafe is a function only …` to the end of that `for` loop with:
  ```c
      /* The functions each profile drives: aquila20 adds speed and turtle, betaflight the
       * FAILSAFE switch. No two may share a channel. */
      int chans[8] = { c->ch_roll, c->ch_pitch, c->ch_throttle, c->ch_yaw, c->ch_arm, c->ch_mode };
      int n = 6;
      if (c->fc_profile == FC_PROFILE_AQUILA20) {
          chans[n++] = c->ch_speed;
          chans[n++] = c->ch_turtle;
      } else {
          chans[n++] = c->ch_failsafe;
      }
      for (int i = 0; i < n; i++) {
          if (chans[i] < 0 || chans[i] > 15)
              return fail(err, errlen, "channel numbers must be 1..16");
          for (int j = i + 1; j < n; j++)
              if (chans[i] == chans[j])
                  return fail(err, errlen, "two functions are mapped to the same channel");
      }
  ```
- Run `grep -rn AQUILA20_SENSITIVITY_CH core` and remove any remaining use.

`core/src/chmap.c`, replace the `else` branch at the end of `chmap_build()`:

```c
    } else {
        ch[c->ch_arm] = sw(c, o->arm && !o->failsafe);   /* Aquila20: FAILSAFE = disarm */
        ch[c->ch_speed] = crsf_us_to_ch(c->stick_min_us + clampi(o->speed, 0, 2) * span / 2);
        ch[c->ch_turtle] = sw(c, o->turtle && !o->failsafe);
    }
```

`core/src/mailbox.h`:
- in `core_event_t`, after `int32_t e, f;`, add `int32_t g, h;          /* EV_STICKS only: speed, turtle */`;
- in the `EV_STICKS` comment, add `g = speed, h = turtle`.

`core/src/evlog.c`, replace the `EV_STICKS` case:

```c
    case EV_STICKS:   /* per mille -> % with one decimal, like the page's readouts */
        m = snprintf(p, left, "\"ev\":\"sticks\",\"roll\":%.1f,\"pitch\":%.1f,\"yaw\":%.1f,\"thr\":%.1f,"
                     "\"mode\":%d,\"speed\":%d,\"turtle\":%s,\"arm\":%s,\"cmd_age_ms\":%d}",
                     ev->a / 10.0, ev->b / 10.0, ev->c / 10.0, ev->d / 10.0, ev->e, ev->g,
                     ev->h ? "true" : "false", ev->f ? "true" : "false", ev->cmd_age_ms);
        break;
```

`core/src/rtloop.c`, in `log_sticks()`, extend the event initialiser with the values on the air:

```c
    bool aquila = l->cfg->fc_profile == FC_PROFILE_AQUILA20;
    core_event_t ev = { .kind = EV_STICKS, .t_ns = l->now_ns, .a = o->roll, .b = o->pitch, .c = o->yaw,
                        .d = o->throttle, .e = o->mode, .f = ch[l->cfg->ch_arm] > CRSF_CH_MID,
                        .g = aquila ? o->speed : 0, .h = aquila && ch[l->cfg->ch_turtle] > CRSF_CH_MID,
                        .session = l->safety.session, .cmd_age_ms = cmd_age_ms(l) };
```

`deploy/crsf-core.conf`:
- change the channel comment's Aquila20 sentence to: `Aquila20: CH5 ARM, CH6 flight mode Normal/Sport/Manual, CH7 speed Slow/Mid/Fast, CH8 turtle.`;
- after `ch_failsafe = 7`, add:
  ```
  ch_speed = 7
  ch_turtle = 8
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
make -s -C core test 2>&1 | tail -1
make -s -C core integration 2>&1 | grep -E "^(Ran|OK|FAILED)"
```
Expected: `ALL TESTS PASSED`; 33 integration tests `OK`. `test_production_config_is_valid` checks `deploy/crsf-core.conf`.

- [ ] **Step 5: Commit**

```bash
git add core deploy/crsf-core.conf
git commit -m "core: speed on CH7 and turtle on CH8 (aquila20), logged with the sticks"   # + trailer
```

---

### Task 3: Gateway: `sp` and `tu` checked, defaulted and forwarded

**Files:**
- Modify: `gateway/src/hub.js:134-145` (`#control`)
- Modify: `gateway/src/ipc.js:37-47` (`encodeControl`)
- Test: `gateway/test/hub.test.js`, `gateway/test/ipc.test.js`

**Interfaces:**
- Consumes: the 19-byte CONTROL layout (Task 1).
- Produces:
  - `core.control(session, seq, { roll, pitch, yaw, throttle, mode, speed, turtle })`;
  - `encodeControl({ …, speed = 0, turtle = 0 })`.

- [ ] **Step 1: Write the failing tests**

`gateway/test/ipc.test.js`:
- replace `CONTROL_GOLDEN` with the bytes from Task 1:
  ```js
  const CONTROL_GOLDEN = Buffer.from([
    0x14, 0x00, 0x02, 0x04, 0x03, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00,
    0x18, 0xfc, 0xfa, 0x00, 0x00, 0x00, 0xe8, 0x03, 0x02, 0x02, 0x01,
  ]);
  ```
- in the test that encodes it, use:
  ```js
    const buf = encodeControl({ session: 0x01020304, seq: 5, roll: -1000, pitch: 250, yaw: 0, throttle: 1000, mode: 2,
      speed: 2, turtle: 1 });
    assert.deepEqual(buf, CONTROL_GOLDEN);
    assert.equal(encodeControl({ session: 1, seq: 1, roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 }).at(-1), 0);
  ```

`gateway/test/hub.test.js`, replace the first two control tests:

```js
test('valid control messages are forwarded with the session', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(1, { r: -1000, p: 250, y: 3, th: 1000, m: 2, sp: 2, tu: 1 }));
  assert.deepEqual(core.calls.at(-1),
    ['control', 42, 1, { roll: -1000, pitch: 250, yaw: 3, throttle: 1000, mode: 2, speed: 2, turtle: 1 }]);
});

test('a page without speed and turtle (older version) flies at Slow with turtle off', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(1));
  assert.deepEqual(core.calls.at(-1)[3], { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0, speed: 0, turtle: 0 });
});

test('malformed or repeated control messages never reach the core', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(5));
  for (const bad of [ctl(5), ctl(4), ctl(6, { r: 1001 }), ctl(6, { th: -1 }), ctl(6, { m: 3 }),
    ctl(6, { p: 0.5 }), ctl(6, { ts: 'x' }), { t: 'ctl', seq: 6 }, ctl(2 ** 32),
    ctl(6, { sp: 3 }), ctl(6, { sp: -1 }), ctl(6, { tu: 2 }), ctl(6, { tu: true }), ctl(6, { sp: 1.5 })]) {
    hub.handle(p, bad);
  }
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 150 npm --prefix gateway test 2>&1 | grep -E "^not ok|^# (pass|fail) "`
Expected: the `ipc` golden test and the three hub control tests fail.

- [ ] **Step 3: Implement**

`gateway/src/hub.js`, replace `#control`:

```js
  #control(c, m) {
    const optional = (v, hi) => v === undefined || isInt(v, 0, hi);   // older pages omit sp/tu
    const valid = isInt(m.seq, c.lastSeq + 1, 0xffffffff) && typeof m.ts === 'number' &&
      isInt(m.r, -1000, 1000) && isInt(m.p, -1000, 1000) && isInt(m.y, -1000, 1000) &&
      isInt(m.th, 0, 1000) && isInt(m.m, 0, 2) && optional(m.sp, 2) && optional(m.tu, 1);
    if (!valid) return; // garbage never refreshes the core's failsafe timer
    c.lastSeq = m.seq;
    if (c.clock.ready && c.clock.age(m.ts, this.now()) > this.maxCommandAgeMs) {
      this.staleDropped++;
      return;
    }
    this.core.control(c.session, m.seq,
      { roll: m.r, pitch: m.p, yaw: m.y, throttle: m.th, mode: m.m, speed: m.sp ?? 0, turtle: m.tu ?? 0 });
  }
```

`gateway/src/ipc.js`, replace `encodeControl`:

```js
export function encodeControl({ session, seq, roll, pitch, yaw, throttle, mode, speed = 0, turtle = 0 }) {
  const p = Buffer.alloc(19);
  p.writeUInt32LE(session >>> 0, 0);
  p.writeUInt32LE(seq >>> 0, 4);
  p.writeInt16LE(roll, 8);
  p.writeInt16LE(pitch, 10);
  p.writeInt16LE(yaw, 12);
  p.writeUInt16LE(throttle, 14);
  p.writeUInt8(mode, 16);
  p.writeUInt8(speed, 17);
  p.writeUInt8(turtle ? 1 : 0, 18);
  return frame(MSG.CONTROL, p);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 150 npm --prefix gateway test 2>&1 | grep -E "^not ok|^# (pass|fail) "`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/hub.js gateway/src/ipc.js gateway/test/hub.test.js gateway/test/ipc.test.js
git commit -m "gateway: forward speed and turtle; older pages default to Slow, turtle off"   # + trailer
```

---

### Task 4: Page model: switches, the control message and the drone's report

**Files:**
- Create: `web/js/switches.js`
- Modify: `web/js/protocol.js:33-35`, `web/js/view.js` (`AQUILA_MODES`, `formatFlightMode`)
- Test: `web/test/switches.test.js` (create), `web/test/protocol.test.js`, `web/test/view.test.js`

**Interfaces:**
- Produces:
  - `export const SPEED_KEYS` (code → 0..2) and `export const TURTLE_KEY = 'KeyT'`;
  - `export class Switches { speed; turtle; setSpeed(n); keyDown(code, repeat) → boolean; turtleOff(); wire(locked) → { sp, tu } }`;
  - `controlMessage(seq, ts, cmd, sw = { sp: 0, tu: 0 })`;
  - `formatFlightMode(text)` → `'Normal · Slow'` etc.;
  - `reportsTurtle(text)` → boolean.

- [ ] **Step 1: Write the failing tests**

Create `web/test/switches.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPEED_KEYS, Switches, TURTLE_KEY } from '../js/switches.js';

test('starts at Slow with turtle off; only valid speeds are taken', () => {
  const s = new Switches();
  assert.deepEqual(s.wire(false), { sp: 0, tu: 0 });
  s.setSpeed(2);
  assert.equal(s.speed, 2);
  for (const bad of [3, -1, 1.5, '1', undefined]) s.setSpeed(bad);
  assert.equal(s.speed, 2);
});

test('keys: T toggles turtle on a fresh press only; 4/5/6 choose the speed', () => {
  const s = new Switches();
  assert.equal(TURTLE_KEY, 'KeyT');
  assert.equal(s.keyDown('KeyT', false), true);
  assert.equal(s.turtle, true);
  for (let i = 0; i < 30; i++) assert.equal(s.keyDown('KeyT', true), true);   // held: no flicker
  assert.equal(s.turtle, true);
  s.keyDown('KeyT', false);
  assert.equal(s.turtle, false);
  for (const [code, speed] of [['Digit6', 2], ['Digit4', 0], ['Numpad5', 1], ['Digit5', 1]]) {
    assert.equal(s.keyDown(code, false), true);
    assert.equal(s.speed, speed);
  }
  assert.equal(SPEED_KEYS.Numpad6, 2);
  assert.equal(s.keyDown('KeyR', false), false);     // arm stays with the page
  assert.equal(s.keyDown('Digit1', false), false);   // flight modes too
});

test('on the wire: turtle is off while inputs are locked (FAILSAFE); speed is kept', () => {
  const s = new Switches();
  s.setSpeed(1);
  s.keyDown('KeyT', false);
  assert.deepEqual(s.wire(false), { sp: 1, tu: 1 });
  assert.deepEqual(s.wire(true), { sp: 1, tu: 0 });
  s.turtleOff();
  assert.deepEqual(s.wire(false), { sp: 1, tu: 0 });
});
```

`web/test/protocol.test.js`, in the test calling `controlMessage(7, 123.5, …)`, add:

```js
  assert.deepEqual(controlMessage(8, 1, { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 }, { sp: 2, tu: 1 }),
    { t: 'ctl', seq: 8, ts: 1, r: 0, p: 0, y: 0, th: 0, m: 0, sp: 2, tu: 1 });
```

The existing assertion, which calls `controlMessage` without `sw`, must now expect `sp: 0, tu: 0` at the end. Update its expected object.

`web/test/view.test.js`:
- replace the flight-mode test:
  ```js
  test('the Aquila20 report is shown as mode and speed, turtle on its own; other texts as they are', () => {
    // The Aquila20 reports "<speed>-<mode>": speed S/M/F (CH7), mode NORMAL/SPORT/MANUAL or TURTLE.
    assert.equal(formatFlightMode('S-NORMAL'), 'Normal · Slow');
    assert.equal(formatFlightMode('F-SPORT'), 'Sport · Fast');
    assert.equal(formatFlightMode('M-MANUAL'), 'Manual · Mid');
    assert.equal(formatFlightMode('S-TURTLE'), 'TURTLE');
    assert.equal(formatFlightMode('ACRO*'), 'ACRO*');            // e.g. Betaflight
    assert.equal(formatFlightMode(null), '—');
    assert.equal(reportsTurtle('F-TURTLE'), true);
    assert.equal(reportsTurtle('S-NORMAL'), false);
    assert.equal(reportsTurtle(null), false);
  });
  ```
- add `reportsTurtle` to that file's import from `../js/view.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 150 npm --prefix gateway test 2>&1 | grep -E "^not ok|^# (pass|fail) "`
Expected: `switches.test.js` fails (module not found); the protocol and view tests fail.

- [ ] **Step 3: Implement**

Create `web/js/switches.js`:

```js
// The Aquila20's two extra switches, as on its own radio (spec 2026-10-14-speed-turtle):
//   speed  (SC, CH7)  0 Slow, 1 Mid, 2 Fast  - can change at any time
//   turtle (SD, CH8)  flips the drone back over; it only acts when the drone is upside down
// Both travel in every control message (sp, tu) like the flight mode. Switches is pure.
export const SPEED_KEYS = { Digit4: 0, Digit5: 1, Digit6: 2, Numpad4: 0, Numpad5: 1, Numpad6: 2 };
export const TURTLE_KEY = 'KeyT';

export class Switches {
  constructor() {
    this.speed = 0;       // Slow: what the drone got before these buttons existed
    this.turtle = false;
  }

  setSpeed(n) {
    if ([0, 1, 2].includes(n)) this.speed = n;
  }

  toggleTurtle() {
    this.turtle = !this.turtle;
  }

  /** After a failsafe or an input-mode change: turtle must not stay on unnoticed. */
  turtleOff() {
    this.turtle = false;
  }

  /** True when the key is one of ours. A held key's auto-repeat does not toggle again. */
  keyDown(code, repeat) {
    if (code === TURTLE_KEY) {
      if (!repeat) this.toggleTurtle();
      return true;
    }
    if (code in SPEED_KEYS) {
      this.setSpeed(SPEED_KEYS[code]);
      return true;
    }
    return false;
  }

  /** The fields for the control message; turtle is off while inputs are locked (FAILSAFE). */
  wire(locked) {
    return { sp: this.speed, tu: this.turtle && !locked ? 1 : 0 };
  }
}
```

`web/js/protocol.js`, replace `controlMessage`:

```js
export const controlMessage = (seq, ts, cmd, sw = { sp: 0, tu: 0 }) => ({
  t: 'ctl', seq, ts, r: cmd.roll, p: cmd.pitch, y: cmd.yaw, th: cmd.throttle, m: cmd.mode, sp: sw.sp, tu: sw.tu,
});
```

`web/js/view.js`, replace the `AQUILA_MODES` block and `formatFlightMode`:

```js
// The Aquila20 reports "<speed>-<mode>" (e.g. "S-NORMAL"): speed S/M/F is CH7, the mode is
// CH6, or TURTLE while it is in turtle mode (CH8 high and upside down).
const AQUILA_MODES = { NORMAL: 'Normal', SPORT: 'Sport', MANUAL: 'Manual' };   // as on the mode buttons
const AQUILA_SPEEDS = { S: 'Slow', M: 'Mid', F: 'Fast' };                      // as on the speed buttons
const AQUILA_REPORT = /^([SMF])-(NORMAL|SPORT|MANUAL|TURTLE)$/;

export function formatFlightMode(text) {
  if (!text) return '—';
  const m = AQUILA_REPORT.exec(text);
  if (!m) return text;
  return m[2] === 'TURTLE' ? 'TURTLE' : `${AQUILA_MODES[m[2]]} · ${AQUILA_SPEEDS[m[1]]}`;
}

export const reportsTurtle = (text) => AQUILA_REPORT.exec(text ?? '')?.[2] === 'TURTLE';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 150 npm --prefix gateway test 2>&1 | grep -E "^not ok|^# (pass|fail) "`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add web/js/switches.js web/js/protocol.js web/js/view.js web/test/switches.test.js \
        web/test/protocol.test.js web/test/view.test.js
git commit -m "web: speed and turtle model, sent in every control message; drone report shown as mode and speed"   # + trailer
```

---

### Task 5: Pilot page: buttons, keys, resets, and a browser test

**Files:**
- Modify: `web/index.html` (footer; both key guides)
- Modify: `web/js/app.js` (imports, state, control loop, resets, render, keys, button listeners)
- Modify: `web/css/app.css`
- Test: `gateway/e2e/keyboard.e2e.js`, `gateway/e2e/layout.e2e.js` (existing, must pass)

**Interfaces:**
- Consumes: `Switches`, `controlMessage(…, sw)`, `formatFlightMode`, `reportsTurtle` (Task 4).
- Produces:
  - buttons `[data-speed="0|1|2"]` and `#btn-turtle`;
  - `#t-mode[data-turtle="true"]` while the drone reports turtle.

- [ ] **Step 1: Write the failing browser test**

`gateway/e2e/keyboard.e2e.js`:
- add constants next to `ARM`: `const SPEED = 6;` and `const TURTLE = 7;`;
- before the final `assert.deepEqual(page.errors, …)`, add:

```js
  // Speed and turtle (Aquila20 CH7, CH8): keys and buttons, in any input mode.
  await hold('6', 50);
  await waitFor(() => channels[SPEED] === HIGH, 2000, 'CH7 high (Fast) after 6');
  await hold('t', 50);
  await waitFor(() => channels[TURTLE] === HIGH, 2000, 'CH8 high (turtle) after T');
  assert.equal(await page.evaluate("document.getElementById('btn-turtle').classList.contains('on')"), true);
  await page.evaluate("document.getElementById('btn-turtle').click()");
  await waitFor(() => channels[TURTLE] === LOW, 2000, 'CH8 low after the Turtle button');
  await page.evaluate("document.querySelector('[data-speed=\"0\"]').click()");
  await waitFor(() => channels[SPEED] === LOW, 2000, 'CH7 low (Slow) after the Slow button');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `make -s -C core && timeout 200 node --test gateway/e2e/keyboard.e2e.js 2>&1 | grep -E "^# (pass|fail) |^  error:"`
Expected: `timed out waiting for CH7 high (Fast) after 6`.

- [ ] **Step 3: Implement**

`web/index.html`:
- in the footer, after the `<div class="modes">…</div>` block:
  ```html
      <div class="modes switches">
        <button data-speed="0" class="on" title="Velocidad lenta (CH7)">Slow</button>
        <button data-speed="1" title="Velocidad media (CH7)">Mid</button>
        <button data-speed="2" title="Velocidad rápida (CH7)">Fast</button>
        <button id="btn-turtle" class="turtle" title="Modo tortuga: voltea el dron si cayó boca abajo (CH8)">Turtle</button>
      </div>
  ```
- in **both** key guides, after the `<li>` for `1 2 3 Normal / Sport / Manual`:
  ```html
        <li><kbd>4</kbd><kbd>5</kbd><kbd>6</kbd> Slow / Mid / Fast</li>
        <li><kbd>T</kbd> Turtle</li>
  ```

`web/js/app.js`:
- import: `import { Switches } from './switches.js';`, and add `reportsTurtle` to the `./view.js` import;
- state, after `let mode = 0;`: `const switches = new Switches();`
- control loop: change the send line to
  ```js
    if (canSend) send(controlMessage(++seq, now, lastCmd, switches.wire(locked)));
  ```
- `startAgainAfterFailsafe()`: add `switches.turtleOff();` after `resetInputs();`;
- `setInputMode()`: add `switches.turtleOff();` after `resetInputs();`;
- `renderInput()`: after the `markOn('[data-intensity]', …)` line, add
  ```js
    markOn('[data-speed]', (b) => Number(b.dataset.speed) === switches.speed);
    $('btn-turtle').classList.toggle('on', switches.turtle);
  ```
- where `$('t-mode').textContent = formatFlightMode(telem.flightMode);` is set, add
  ```js
    $('t-mode').dataset.turtle = String(reportsTurtle(telem.flightMode));
  ```
- button listeners, next to the `[data-mode]` loop:
  ```js
  for (const b of document.querySelectorAll('[data-speed]')) {
    b.addEventListener('click', () => switches.setSpeed(Number(b.dataset.speed)));
  }
  $('btn-turtle').addEventListener('click', () => switches.toggleTurtle());
  ```
- keydown handler: directly after the `keyboard`/`stepper` block (before `const action = KEY_ACTIONS[ev.code];`), add
  ```js
    if (switches.keyDown(ev.code, ev.repeat)) {
      ev.preventDefault();
      return;
    }
  ```

`web/css/app.css`:
- after `.modes button.on { … }`:
  ```css
  /* Turtle on: the warning colour, so it is never left on unnoticed. */
  .modes button.turtle.on { color: #ffd9a8; border-color: var(--warn, #f0a040); background: rgba(240, 160, 64, .2); }
  .telemetry dd[data-turtle="true"] { color: var(--warn, #f0a040); font-weight: 700; }
  ```
- in the portrait block, where `.modes { grid-column: 1 / -1; … repeat(3, 1fr); }` is, add
  ```css
    .modes.switches { grid-template-columns: repeat(4, 1fr); }
  ```

Check that `--warn` exists in `:root` (`grep -n "\-\-warn" web/css/app.css`). If it doesn't, keep the fallback colour.

- [ ] **Step 4: Run the browser test and the layout tests**

Run:
```bash
timeout 200 node --test gateway/e2e/keyboard.e2e.js 2>&1 | grep -E "^# (pass|fail) |^  error:"
timeout 300 node --test gateway/e2e/layout.e2e.js 2>&1 | grep -E "^not ok|^# (pass|fail) |^  error:"
```
Expected: `# fail 0` for both.
- **If a layout test fails at 640×360**, the footer wrapped to three rows. Inside `@media (max-height: 450px)`, put `.modes` and `.modes.switches` on one row (`.controls { row-gap: 4px }`, `.modes button { padding: 4px 8px; font-size: 12px }`) and re-run.
- Then take screenshots at 640×360, 390×844 and 1280×800 (the throwaway script used for the earlier layout fixes) and check the footer by eye.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/js/app.js web/css/app.css gateway/e2e/keyboard.e2e.js
git commit -m "web: Slow/Mid/Fast and Turtle buttons and keys on the pilot page"   # + trailer
```

---

### Task 6: Documentation, the full test run, and the bench check

**Files:**
- Modify: `docs/setup/aquila20.md`, `docs/superpowers/specs/2026-10-07-aquila20-profile-design.md`, `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`
- Modify (local, untracked): `docs/procedures/m4-pilot-checklist.md`

- [ ] **Step 1: Update the docs**

- **`docs/setup/aquila20.md`:**
  - in the channel table, replace the CH7 row with `| CH7 | speed: low SLOW (S), mid MID (M), high FAST (F); set by the pilot (Slow/Mid/Fast buttons, keys 4/5/6) | 1000 / 1500 / 2000 µs |`;
  - add `| CH8 | turtle mode: high = on (Turtle button, key T). Only acts upside down; latches until the drone is upright | 1000 / 2000 µs |`;
  - add a section "Turtle mode (spike 2026-10-14)" with the table from the spec §2.
- **`docs/superpowers/specs/2026-10-07-aquila20-profile-design.md`:** under §3.1's table, add `- **Amended 2026-10-14:** CH7 (speed) and CH8 (turtle) are set by the pilot; see 2026-10-14-speed-turtle-design.md.`
- **`docs/ARCHITECTURE.md`:**
  - the `ctl` row becomes `ctl {seq, ts, r, p, y, th, m, sp, tu}` (and the sequence diagram's `ctl {…}`);
  - the CONTROL row gets `, u8 speed, u8 turtle`;
  - the channel table's CH7 row becomes `aquila20: speed Slow/Mid/Fast; betaflight: FAILSAFE switch`, plus a CH8 row `aquila20: turtle`;
  - the footer row gets `Slow / Mid / Fast, Turtle`; the keys table gets `4 / 5 / 6` and `T`;
  - the stick-log example line gets `"speed":0,"turtle":false`.
- **`docs/procedures/m4-pilot-checklist.md`** (untracked): add rows "Tap Fast, then Slow → the mode line shows "Normal · Fast", then "Normal · Slow"" and "Turtle on with the drone upright → nothing on the drone; the button is highlighted".

- [ ] **Step 2: Run all five suites and update HANDOFF's counts**

```bash
vcgencmd measure_temp
make -s -C core test 2>&1 | tail -1; grep -ho "RUN(test_[a-z0-9_]*)" core/tests/*.c | wc -l
make -s -C core integration 2>&1 | grep -E "^(Ran|OK|FAILED)"
timeout 150 npm --prefix gateway test 2>&1 | grep -E "^not ok|^# (pass|fail) "
timeout 100 npm --prefix relay test 2>&1 | grep -E "^# (pass|fail) "
python3 -W error -m unittest discover -s tools/analysis -t tools/analysis 2>&1 | grep -E "^Ran|^OK|FAILED"
make -s -C core >/dev/null && timeout 700 npm --prefix gateway run e2e 2>&1 | grep -E "^not ok|^# (pass|fail) |^  error:"
```

Expected: all pass. Put the new counts in `docs/HANDOFF.md` §5: C unit, integration, and gateway + web.

- [ ] **Step 3: Commit**

```bash
git add docs/setup/aquila20.md docs/superpowers/specs/2026-10-07-aquila20-profile-design.md docs/ARCHITECTURE.md docs/HANDOFF.md
git commit -m "docs: speed and turtle in the Aquila20 setup, the architecture and the test counts"   # + trailer
```

- [ ] **Step 4: Bench check with the pilot (propellers off; after merge and install)**

Install, then restart **both** the core and the gateway (`sudo deploy/install.sh && sudo systemctl restart crsf-core gcs-gateway`):
1. Speed: Slow → Mid → Fast; "Modo FC" shows `Normal · Slow`, `· Mid`, `· Fast`.
2. Drone upside down, Turtle on → "TURTLE" in the warning colour; turn upright → `Normal · …`; Turtle off.
3. Armed turtle flip (**never tested**): upside down, Turtle on, arm, nudge a stick, and watch the motors turn in reverse. Disarm, then Turtle off. Record the result in `aquila20.md`.
