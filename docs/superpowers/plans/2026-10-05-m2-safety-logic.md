# M2: Safety Logic (Config, Channel Map, Arming and Failsafe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The decision-making half of crsf-core as pure, unit-tested C: its settings file, the mapping from pilot commands to the 16 CRSF channels, and the arming/failsafe state machine that decides what goes on the air.

**Architecture:** Three modules without I/O or threads: every function takes the current time as a parameter, so every safety rule (timeouts, sequence numbers, latching, acknowledge interlocks) is tested deterministically. Milestone 3 wires them into the real-time loop.

**Tech Stack:** C (gnu11), the Milestone 1 Makefile and `check.h`.

**Spec:** `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (read it first; section numbers below refer to it)

**Before you start:** Milestone 1 is done (`make -C core test` passes). Read spec §2 (P1–P5), §4.4 (channel table) and §5.3 (state machine); the state machine is the most safety-critical code in the project.

## Global Constraints

- Work in `~/ProyectoTerminal/elrs-web-gcs` on branch `main`; run every command from the repository root.
- Target: Raspberry Pi 4, Debian 13 arm64, gcc 14 (`-std=gnu11`), GNU make, Python 3.13 standard library only.
- Every file below was compiled and tested on that Pi before this plan was written: type it exactly. If a step's output differs from **Expected**, stop and find out why; do not edit a test to make it pass.
- **Propellers off** for every step that touches real hardware.
- Expected output is quoted in English; tools print some messages (compiler, `make`, Python errors) in the system's language.
- C flags `-std=gnu11 -Wall -Wextra -Werror -Wshadow -Wstrict-prototypes`; unit tests add UBSan (`-fsanitize=undefined`). AddressSanitizer does not work with this Pi's kernel: do not add it.
- Command timeout 300 ms (`cmd_timeout_ms`, allowed 100–900). A command is fresh only if it belongs to the current session and its sequence number is higher than the last applied.
- ARM is CH5 (AUX1), enforced; FAILSAFE is CH7 (AUX3); mode switch CH6 at 1000/1500/2000 µs; sticks map to 1000–2000 µs; unused channels 1000 µs.
- FAILSAFE: FAILSAFE switch high, sticks centred, throttle 0, **ARM unchanged**; latched until an acknowledge that needs the current session, a fresh link, throttle ≤ `throttle_arm_max` (50 of 1000) and no FC "armed" report in the last `fc_armed_fresh_ms` (3000).
- Config file: `key = value` lines, `#` comments, 1-based channel numbers; unknown keys are errors.

## Review Focus

Inputs and failure modes most likely to hurt a real user; each is pinned by a test in the task named.

1. Repeated, reordered or replayed commands must never keep an armed drone alive (Task 3, `test_old_or_repeated_sequence_numbers_are_ignored`, `test_pilot_lost_while_armed`).
2. The timeout boundary: still armed at exactly 300 ms, failsafe 1 ns later (Task 3, `test_timeout_boundary`).
3. The operator clears failsafe while Betaflight is still flying its landing → refused; an old report does not block forever (Task 3, `test_ack_refusals_and_success`, `test_stale_fc_report_does_not_block_ack`).
4. A config file edited on Windows (CRLF) or with trailing comments still parses; typos are errors with line numbers (Task 1, `test_windows_line_endings`, `test_unknown_key_reports_line`).
5. Out-of-range stick values from upstream are clamped, never wrapped (Tasks 2 and 3, `test_out_of_range_inputs_are_clamped`, `test_values_are_clamped`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `core/src/config.{h,c}` | crsf-core settings: defaults, `key = value` parser, validation |
| `core/src/chmap.{h,c}` | safety outputs → 16 CRSF channel values |
| `core/src/safety.{h,c}` | arming and failsafe state machine (pure logic) |
| `core/tests/test_config.c, test_chmap.c, test_safety.c` | unit tests |

### Task 1: Settings file

**Files:**
- Create: `core/src/config.h`
- Create: `core/src/config.c`
- Test: `core/tests/test_config.c`

**Interfaces:**
- Consumes: nothing
- Produces: `config_t` (fields listed in config.h; channel fields are 0-based), `void config_defaults(config_t *)`, `int config_set(config_t *, key, value, err, errlen)`, `int config_validate(const config_t *, err, errlen)`, `int config_load(config_t *, path, err, errlen)`

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_config.c`:

```c
#define _GNU_SOURCE
#include "check.h"
#include "config.h"

#include <stdlib.h>
#include <unistd.h>

static char err[256];

static const char *write_temp(const char *text)
{
    static char path[] = "/tmp/crsf-config-XXXXXX";
    snprintf(path, sizeof path, "/tmp/crsf-config-XXXXXX");
    int fd = mkstemp(path);
    if (fd < 0)
        return NULL;
    if (write(fd, text, strlen(text)) < 0)
        return NULL;
    close(fd);
    return path;
}

static void test_defaults_are_valid(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(c.ch_arm, 4);
    CHECK_EQ_INT(c.cmd_timeout_ms, 300);
}

static void test_load_file_with_comments_and_spaces(void)
{
    const char *path = write_temp(
        "# crsf-core test config\n"
        "serial_device = /dev/pts/9   # fake module\n"
        "\n"
        "  baud=400000\n"
        "ch_throttle = 1\n"
        "ch_roll = 3\n"
        "rt_required = yes\n"
        "event_log = /tmp/events.jsonl\n");
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, path, err, sizeof err), 0);
    CHECK_STR(c.serial_device, "/dev/pts/9");
    CHECK_EQ_INT(c.baud, 400000);
    CHECK_EQ_INT(c.ch_throttle, 0);
    CHECK_EQ_INT(c.ch_roll, 2);
    CHECK(c.rt_required);
    CHECK_STR(c.event_log, "/tmp/events.jsonl");
    unlink(path);
}

static void test_windows_line_endings(void)
{
    const char *path = write_temp("baud = 400000\r\nrt_required = true\r\n");
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, path, err, sizeof err), 0);
    CHECK_EQ_INT(c.baud, 400000);
    CHECK(c.rt_required);
    unlink(path);
}

static void test_unknown_key_reports_line(void)
{
    const char *path = write_temp("baud = 921600\nbaudrate = 9600\n");
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, path, err, sizeof err), -1);
    CHECK(strstr(err, ":2: unknown setting \"baudrate\"") != NULL);
    unlink(path);
}

static void test_bad_values_are_rejected(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "baud", "fast", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "baud", "12x", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "17", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "0", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "rt_required", "maybe", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "missing_equals", "", err, sizeof err), -1);
}

static void test_validation_rules(void)
{
    config_t c;

    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_arm", "8", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK(strstr(err, "CH5") != NULL);

    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "7", err, sizeof err), 0);   /* same as failsafe */
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);

    config_defaults(&c);
    c.cmd_timeout_ms = 1000;
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);

    config_defaults(&c);
    c.stick_min_us = 1500;
    c.stick_max_us = 1500;
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
}

static void test_missing_file(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, "/nonexistent/crsf-core.conf", err, sizeof err), -1);
    CHECK(strstr(err, "No such file") != NULL);
}

int main(void)
{
    RUN(test_defaults_are_valid);
    RUN(test_load_file_with_comments_and_spaces);
    RUN(test_windows_line_endings);
    RUN(test_unknown_key_reports_line);
    RUN(test_bad_values_are_rejected);
    RUN(test_validation_rules);
    RUN(test_missing_file);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_config.c:3:10: fatal error: config.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/config.h`:

```c
/* config.h - crsf-core settings, loaded from a "key = value" file. */
#ifndef CONFIG_H
#define CONFIG_H

#include <stdbool.h>
#include <stddef.h>

#define CONFIG_PATH_MAX 256

typedef struct {
    char serial_device[CONFIG_PATH_MAX];
    int baud;
    char socket_path[CONFIG_PATH_MAX];
    char event_log[CONFIG_PATH_MAX];   /* JSON lines; "" = disabled */
    char timing_log[CONFIG_PATH_MAX];  /* per-frame CSV; "" = disabled */
    int default_period_us;             /* frame period until the module sends timing frames */
    int sync_margin_us;                /* aim frames this much earlier than the module asks */
    int cmd_timeout_ms;                /* armed + no fresh command this long -> failsafe */
    int throttle_arm_max;              /* 0..1000; throttle must be <= this to arm or clear failsafe */
    int fc_armed_fresh_ms;             /* how long an "FC is armed" telemetry report stays valid */
    int model_id;                      /* ELRS model slot selected at start-up */
    int rt_priority;                   /* SCHED_FIFO priority of the frame loop; 0 = leave as is */
    int rt_cpu;                        /* CPU the frame loop is pinned to; -1 = no pinning */
    bool rt_required;                  /* refuse to run if real-time setup fails */
    int stick_min_us;
    int stick_max_us;
    /* 0-based channel indexes. The file uses 1-based numbers (ch_arm = 5 means CH5). */
    int ch_roll, ch_pitch, ch_throttle, ch_yaw, ch_arm, ch_mode, ch_failsafe;
} config_t;

void config_defaults(config_t *c);
/* Applies one setting. Returns 0, or -1 with a message in err. */
int config_set(config_t *c, const char *key, const char *value, char *err, size_t errlen);
/* Cross-field checks. Returns 0, or -1 with a message in err. */
int config_validate(const config_t *c, char *err, size_t errlen);
/* Reads "key = value" lines ('#' starts a comment) over the current values, then validates. */
int config_load(config_t *c, const char *path, char *err, size_t errlen);

#endif
```

Create `core/src/config.c`:

```c
#include "config.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void config_defaults(config_t *c)
{
    memset(c, 0, sizeof *c);
    snprintf(c->serial_device, sizeof c->serial_device, "/dev/ttyUSB0");
    c->baud = 921600;
    snprintf(c->socket_path, sizeof c->socket_path, "/run/crsf-core/core.sock");
    c->default_period_us = 4000;
    c->sync_margin_us = 1000;
    c->cmd_timeout_ms = 300;
    c->throttle_arm_max = 50;
    c->fc_armed_fresh_ms = 3000;
    c->model_id = 0;
    c->rt_priority = 80;
    c->rt_cpu = 3;
    c->rt_required = false;
    c->stick_min_us = 1000;
    c->stick_max_us = 2000;
    c->ch_roll = 0;      /* CH1 */
    c->ch_pitch = 1;     /* CH2 */
    c->ch_throttle = 2;  /* CH3 */
    c->ch_yaw = 3;       /* CH4 */
    c->ch_arm = 4;       /* CH5 = AUX1: ExpressLRS sends it with every packet */
    c->ch_mode = 5;      /* CH6 = AUX2 */
    c->ch_failsafe = 6;  /* CH7 = AUX3 */
}

static int parse_int(const char *s, int *out)
{
    char *end;
    errno = 0;
    long v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || v < -1000000000L || v > 1000000000L)
        return -1;
    *out = (int)v;
    return 0;
}

static int parse_bool(const char *s, bool *out)
{
    if (!strcmp(s, "true") || !strcmp(s, "yes") || !strcmp(s, "1")) {
        *out = true;
        return 0;
    }
    if (!strcmp(s, "false") || !strcmp(s, "no") || !strcmp(s, "0")) {
        *out = false;
        return 0;
    }
    return -1;
}

static int set_string(char *dst, size_t cap, const char *value)
{
    if (strlen(value) >= cap)
        return -1;
    snprintf(dst, cap, "%s", value);
    return 0;
}

int config_set(config_t *c, const char *key, const char *value, char *err, size_t errlen)
{
    static const struct { const char *key; size_t off; } strings[] = {
        { "serial_device", offsetof(config_t, serial_device) },
        { "socket_path", offsetof(config_t, socket_path) },
        { "event_log", offsetof(config_t, event_log) },
        { "timing_log", offsetof(config_t, timing_log) },
    };
    static const struct { const char *key; size_t off; } ints[] = {
        { "baud", offsetof(config_t, baud) },
        { "default_period_us", offsetof(config_t, default_period_us) },
        { "sync_margin_us", offsetof(config_t, sync_margin_us) },
        { "cmd_timeout_ms", offsetof(config_t, cmd_timeout_ms) },
        { "throttle_arm_max", offsetof(config_t, throttle_arm_max) },
        { "fc_armed_fresh_ms", offsetof(config_t, fc_armed_fresh_ms) },
        { "model_id", offsetof(config_t, model_id) },
        { "rt_priority", offsetof(config_t, rt_priority) },
        { "rt_cpu", offsetof(config_t, rt_cpu) },
        { "stick_min_us", offsetof(config_t, stick_min_us) },
        { "stick_max_us", offsetof(config_t, stick_max_us) },
    };
    static const struct { const char *key; size_t off; } channels[] = {
        { "ch_roll", offsetof(config_t, ch_roll) },
        { "ch_pitch", offsetof(config_t, ch_pitch) },
        { "ch_throttle", offsetof(config_t, ch_throttle) },
        { "ch_yaw", offsetof(config_t, ch_yaw) },
        { "ch_arm", offsetof(config_t, ch_arm) },
        { "ch_mode", offsetof(config_t, ch_mode) },
        { "ch_failsafe", offsetof(config_t, ch_failsafe) },
    };
    char *base = (char *)c;

    for (size_t i = 0; i < sizeof strings / sizeof strings[0]; i++) {
        if (!strcmp(key, strings[i].key)) {
            if (set_string(base + strings[i].off, CONFIG_PATH_MAX, value) == 0)
                return 0;
            snprintf(err, errlen, "%s: value too long", key);
            return -1;
        }
    }
    for (size_t i = 0; i < sizeof ints / sizeof ints[0]; i++) {
        if (!strcmp(key, ints[i].key)) {
            if (parse_int(value, (int *)(void *)(base + ints[i].off)) == 0)
                return 0;
            snprintf(err, errlen, "%s: not an integer: \"%s\"", key, value);
            return -1;
        }
    }
    for (size_t i = 0; i < sizeof channels / sizeof channels[0]; i++) {
        if (!strcmp(key, channels[i].key)) {
            int ch;
            if (parse_int(value, &ch) != 0 || ch < 1 || ch > 16) {
                snprintf(err, errlen, "%s: must be a channel number 1..16, got \"%s\"", key, value);
                return -1;
            }
            *(int *)(void *)(base + channels[i].off) = ch - 1;
            return 0;
        }
    }
    if (!strcmp(key, "rt_required")) {
        if (parse_bool(value, &c->rt_required) == 0)
            return 0;
        snprintf(err, errlen, "rt_required: expected true or false, got \"%s\"", value);
        return -1;
    }
    snprintf(err, errlen, "unknown setting \"%s\"", key);
    return -1;
}

static int fail(char *err, size_t errlen, const char *msg)
{
    snprintf(err, errlen, "%s", msg);
    return -1;
}

int config_validate(const config_t *c, char *err, size_t errlen)
{
    if (c->serial_device[0] == '\0' || c->socket_path[0] == '\0')
        return fail(err, errlen, "serial_device and socket_path must be set");
    if (c->baud <= 0)
        return fail(err, errlen, "baud must be positive");
    if (c->default_period_us < 500 || c->default_period_us > 50000)
        return fail(err, errlen, "default_period_us must be 500..50000");
    if (c->sync_margin_us < 0 || c->sync_margin_us > 5000)
        return fail(err, errlen, "sync_margin_us must be 0..5000");
    if (c->cmd_timeout_ms < 100 || c->cmd_timeout_ms > 900)
        return fail(err, errlen, "cmd_timeout_ms must be 100..900 (failsafe must react in < 1 s)");
    if (c->throttle_arm_max < 0 || c->throttle_arm_max > 300)
        return fail(err, errlen, "throttle_arm_max must be 0..300");
    if (c->fc_armed_fresh_ms < 0)
        return fail(err, errlen, "fc_armed_fresh_ms must be >= 0");
    if (c->model_id < 0 || c->model_id > 63)
        return fail(err, errlen, "model_id must be 0..63");
    if (c->rt_priority < 0 || c->rt_priority > 98)
        return fail(err, errlen, "rt_priority must be 0..98");
    if (c->rt_cpu < -1 || c->rt_cpu > 63)
        return fail(err, errlen, "rt_cpu must be -1..63");
    if (c->stick_min_us < 988 || c->stick_max_us > 2012 || c->stick_min_us >= c->stick_max_us)
        return fail(err, errlen, "need 988 <= stick_min_us < stick_max_us <= 2012");
    if (c->ch_arm != 4)
        return fail(err, errlen, "ch_arm must be 5: ExpressLRS sends AUX1 (CH5) with every packet");

    const int chans[] = { c->ch_roll, c->ch_pitch, c->ch_throttle, c->ch_yaw,
                          c->ch_arm, c->ch_mode, c->ch_failsafe };
    const int n = (int)(sizeof chans / sizeof chans[0]);
    for (int i = 0; i < n; i++) {
        if (chans[i] < 0 || chans[i] > 15)
            return fail(err, errlen, "channel numbers must be 1..16");
        for (int j = i + 1; j < n; j++)
            if (chans[i] == chans[j])
                return fail(err, errlen, "two functions are mapped to the same channel");
    }
    return 0;
}

static char *trim(char *s)
{
    while (isspace((unsigned char)*s))
        s++;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1]))
        *--e = '\0';
    return s;
}

int config_load(config_t *c, const char *path, char *err, size_t errlen)
{
    FILE *f = fopen(path, "r");
    if (f == NULL) {
        snprintf(err, errlen, "%s: %s", path, strerror(errno));
        return -1;
    }
    char line[512];
    int lineno = 0;
    while (fgets(line, sizeof line, f) != NULL) {
        lineno++;
        char *hash = strchr(line, '#');
        if (hash != NULL)
            *hash = '\0';
        char *s = trim(line);
        if (*s == '\0')
            continue;
        char *eq = strchr(s, '=');
        if (eq == NULL) {
            snprintf(err, errlen, "%s:%d: expected key = value", path, lineno);
            fclose(f);
            return -1;
        }
        *eq = '\0';
        char msg[256];
        if (config_set(c, trim(s), trim(eq + 1), msg, sizeof msg) != 0) {
            snprintf(err, errlen, "%s:%d: %s", path, lineno, msg);
            fclose(f);
            return -1;
        }
    }
    fclose(f);
    return config_validate(c, err, errlen);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/config.c core/src/config.h core/tests/test_config.c
git commit -m "core: crsf-core settings file with validation"
```

### Task 2: Channel map

**Files:**
- Create: `core/src/chmap.h`
- Create: `core/src/chmap.c`
- Test: `core/tests/test_chmap.c`

**Interfaces:**
- Consumes: `config_t`, `crsf_us_to_ch`
- Produces: `rc_outputs_t` {roll, pitch, yaw −1000..1000; throttle 0..1000; mode 0..2; arm; failsafe}, `void chmap_build(const config_t *, const rc_outputs_t *, uint16_t ch[16])`

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_chmap.c`:

```c
#include "check.h"
#include "chmap.h"

static void test_neutral_outputs(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { 0 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(ch[0], 992);   /* roll centred */
    CHECK_EQ_INT(ch[1], 992);   /* pitch centred */
    CHECK_EQ_INT(ch[2], 192);   /* throttle 1000 us */
    CHECK_EQ_INT(ch[3], 992);   /* yaw centred */
    CHECK_EQ_INT(ch[4], 192);   /* arm low */
    CHECK_EQ_INT(ch[5], 192);   /* mode position 0 */
    CHECK_EQ_INT(ch[6], 192);   /* failsafe low */
    for (int i = 7; i < CRSF_NUM_CHANNELS; i++)
        CHECK_EQ_INT(ch[i], 192);
}

static void test_full_deflection_and_switches(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { .roll = 1000, .pitch = -1000, .yaw = 500, .throttle = 1000,
                       .mode = 1, .arm = true, .failsafe = true };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[0]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[1]), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[3]), 1750);
    CHECK_EQ_INT(crsf_ch_to_us(ch[2]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 1500);
    CHECK_EQ_INT(crsf_ch_to_us(ch[4]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 2000);
    o.mode = 2;
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);
}

static void test_out_of_range_inputs_are_clamped(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { .roll = 30000, .pitch = -30000, .throttle = 5000, .mode = 9 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[0]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[1]), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[2]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);
}

static void test_custom_channel_order(void)
{
    config_t c;
    config_defaults(&c);
    c.ch_throttle = 0;    /* TAER */
    c.ch_roll = 1;
    c.ch_pitch = 2;
    rc_outputs_t o = { .roll = 1000, .throttle = 0 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[0]), 1000);   /* throttle low on CH1 */
    CHECK_EQ_INT(crsf_ch_to_us(ch[1]), 2000);   /* roll right on CH2 */
}

int main(void)
{
    RUN(test_neutral_outputs);
    RUN(test_full_deflection_and_switches);
    RUN(test_out_of_range_inputs_are_clamped);
    RUN(test_custom_channel_order);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_chmap.c:2:10: fatal error: chmap.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/chmap.h`:

```c
/* chmap.h - turn the safety layer's outputs into the 16 CRSF channel values. */
#ifndef CHMAP_H
#define CHMAP_H

#include <stdbool.h>
#include <stdint.h>
#include "config.h"
#include "crsf.h"

typedef struct {
    int16_t roll, pitch, yaw;  /* -1000..1000, 0 = centred */
    uint16_t throttle;         /* 0..1000 */
    uint8_t mode;              /* flight-mode switch position 0..2 */
    bool arm;                  /* ARM switch high */
    bool failsafe;             /* FAILSAFE switch high */
} rc_outputs_t;

/* Sticks map linearly onto stick_min_us..stick_max_us, switches onto min/max (mode
 * position 1 = centre). Channels without a function stay at stick_min_us (low). */
void chmap_build(const config_t *cfg, const rc_outputs_t *o, uint16_t ch[CRSF_NUM_CHANNELS]);

#endif
```

Create `core/src/chmap.c`:

```c
#include "chmap.h"

static int clampi(int v, int lo, int hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

static uint16_t stick(const config_t *c, int v)
{
    v = clampi(v, -1000, 1000);
    int span = c->stick_max_us - c->stick_min_us;
    return crsf_us_to_ch((c->stick_min_us + c->stick_max_us) / 2 + v * span / 2000);
}

static uint16_t sw(const config_t *c, bool on)
{
    return crsf_us_to_ch(on ? c->stick_max_us : c->stick_min_us);
}

void chmap_build(const config_t *c, const rc_outputs_t *o, uint16_t ch[CRSF_NUM_CHANNELS])
{
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = crsf_us_to_ch(c->stick_min_us);

    int span = c->stick_max_us - c->stick_min_us;
    int mode = clampi(o->mode, 0, 2);
    ch[c->ch_roll] = stick(c, o->roll);
    ch[c->ch_pitch] = stick(c, o->pitch);
    ch[c->ch_yaw] = stick(c, o->yaw);
    ch[c->ch_throttle] = crsf_us_to_ch(c->stick_min_us + clampi(o->throttle, 0, 1000) * span / 1000);
    ch[c->ch_mode] = crsf_us_to_ch(c->stick_min_us + mode * span / 2);
    ch[c->ch_arm] = sw(c, o->arm);
    ch[c->ch_failsafe] = sw(c, o->failsafe);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/chmap.c core/src/chmap.h core/tests/test_chmap.c
git commit -m "core: map pilot outputs onto CRSF channels"
```

### Task 3: Arming and failsafe state machine

21 scenario tests pin every rule of spec §5.3. Times are nanoseconds passed in by the caller.

**Files:**
- Create: `core/src/safety.h`
- Create: `core/src/safety.c`
- Test: `core/tests/test_safety.c`

**Interfaces:**
- Consumes: `rc_outputs_t`
- Produces: `safety_t`, `stick_cmd_t`, enums `safety_state_t` (DISARMED/ARMED/FAILSAFE), `fs_reason_t`, `fc_arm_t`, `refuse_t`; `safety_init`, `safety_link_fresh`, `safety_session_start`, `safety_control`, `safety_arm`, `safety_disarm`, `safety_ack`, `safety_pilot_lost`, `safety_gateway_lost`, `safety_trigger`, `safety_fc_flight_mode`, `safety_tick`, and the `safety_*_name` helpers

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_safety.c`:

```c
#include "check.h"
#include "safety.h"

#define MS 1000000LL
#define TIMEOUT (300 * MS)
#define FC_FRESH (3000 * MS)

static const stick_cmd_t LOW = { 0, 0, 0, 0, 0 };

static void setup(safety_t *s)
{
    safety_init(s, TIMEOUT, FC_FRESH, 50);
}

/* Session 7 with one fresh command at t=0 and armed. */
static void armed(safety_t *s)
{
    setup(s);
    safety_session_start(s, 7);
    CHECK(safety_control(s, 7, 1, &LOW, 0));
    CHECK_EQ_INT(safety_arm(s, 7, 0), REFUSE_NONE);
}

static void test_starts_disarmed_with_safe_outputs(void)
{
    safety_t s;
    setup(&s);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.arm);
    CHECK(!s.out.failsafe);
    CHECK_EQ_INT(s.out.throttle, 0);
}

static void test_commands_need_the_current_session(void)
{
    safety_t s;
    setup(&s);
    stick_cmd_t c = { .roll = 100 };
    CHECK(!safety_control(&s, 7, 1, &c, 0));          /* no session yet */
    safety_session_start(&s, 7);
    CHECK(!safety_control(&s, 8, 1, &c, 0));          /* other session */
    CHECK(safety_control(&s, 7, 1, &c, 0));
    CHECK_EQ_INT(s.out.roll, 100);
}

static void test_old_or_repeated_sequence_numbers_are_ignored(void)
{
    safety_t s;
    armed(&s);
    stick_cmd_t c = { .pitch = 200 };
    CHECK(safety_control(&s, 7, 5, &c, 100 * MS));
    CHECK(!safety_control(&s, 7, 5, &c, 250 * MS));   /* repeat does not refresh the link */
    CHECK(!safety_control(&s, 7, 4, &c, 250 * MS));
    safety_tick(&s, 401 * MS);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_CMD_TIMEOUT);
}

static void test_values_are_clamped(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 1);
    stick_cmd_t c = { .roll = 30000, .pitch = -30000, .yaw = 5, .throttle = 4000, .mode = 9 };
    CHECK(safety_control(&s, 1, 1, &c, 0));
    CHECK_EQ_INT(s.out.roll, 1000);
    CHECK_EQ_INT(s.out.pitch, -1000);
    CHECK_EQ_INT(s.out.throttle, 1000);
    CHECK_EQ_INT(s.out.mode, 2);
}

static void test_arm_refusals(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    CHECK_EQ_INT(safety_arm(&s, 7, 0), REFUSE_LINK_STALE);       /* no command yet */
    stick_cmd_t high = { .throttle = 51 };
    CHECK(safety_control(&s, 7, 1, &high, 0));
    CHECK_EQ_INT(safety_arm(&s, 7, 0), REFUSE_THROTTLE_HIGH);
    CHECK(safety_control(&s, 7, 2, &LOW, 0));
    CHECK_EQ_INT(safety_arm(&s, 9, 0), REFUSE_WRONG_SESSION);
    CHECK_EQ_INT(safety_arm(&s, 7, 301 * MS), REFUSE_LINK_STALE); /* link went stale */
    CHECK_EQ_INT(safety_arm(&s, 7, 300 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    CHECK(s.out.arm);
    CHECK_EQ_INT(safety_arm(&s, 7, 300 * MS), REFUSE_NOT_DISARMED);
}

static void test_timeout_boundary(void)
{
    safety_t s;
    armed(&s);
    safety_tick(&s, TIMEOUT);              /* exactly at the limit: still fresh */
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    safety_tick(&s, TIMEOUT + 1);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
}

static void test_failsafe_outputs(void)
{
    safety_t s;
    armed(&s);
    stick_cmd_t c = { .roll = 500, .pitch = 500, .yaw = 500, .throttle = 600, .mode = 1 };
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    safety_tick(&s, 400 * MS);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK(s.out.failsafe);
    CHECK(s.out.arm);                      /* ARM untouched: Betaflight runs its procedure */
    CHECK_EQ_INT(s.out.roll, 0);
    CHECK_EQ_INT(s.out.pitch, 0);
    CHECK_EQ_INT(s.out.yaw, 0);
    CHECK_EQ_INT(s.out.throttle, 0);
    CHECK_EQ_INT(s.out.mode, 1);
}

static void test_commands_in_failsafe_refresh_link_but_not_sticks(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    stick_cmd_t c = { .roll = 700, .throttle = 900 };
    CHECK(safety_control(&s, 7, 2, &c, 50 * MS));
    CHECK(safety_link_fresh(&s, 50 * MS));
    CHECK_EQ_INT(s.out.roll, 0);
    CHECK_EQ_INT(s.out.throttle, 0);
}

static void test_disarmed_timeout_does_not_latch(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    CHECK(safety_control(&s, 7, 1, &LOW, 0));
    safety_tick(&s, 10000 * MS);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
}

static void test_pilot_lost_while_armed(void)
{
    safety_t s;
    armed(&s);
    safety_pilot_lost(&s, 8);              /* someone else's session: ignored */
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    safety_pilot_lost(&s, 7);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_PILOT_LOST);
    CHECK(!safety_control(&s, 7, 9, &LOW, 1 * MS));   /* late message from that session */
}

static void test_gateway_lost_while_armed(void)
{
    safety_t s;
    armed(&s);
    safety_gateway_lost(&s);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_GATEWAY_LOST);
}

static void test_new_session_while_armed(void)
{
    safety_t s;
    armed(&s);
    safety_session_start(&s, 8);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_SESSION_CHANGED);
}

static void test_first_failsafe_reason_is_kept(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    safety_gateway_lost(&s);
    CHECK_EQ_INT(s.fs_reason, FS_MANUAL);
}

static void test_ack_refusals_and_success(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    stick_cmd_t high = { .throttle = 400 };

    CHECK_EQ_INT(safety_ack(&s, 9, 10 * MS), REFUSE_WRONG_SESSION);
    CHECK_EQ_INT(safety_ack(&s, 7, 400 * MS), REFUSE_LINK_STALE);
    CHECK(safety_control(&s, 7, 2, &high, 400 * MS));
    CHECK_EQ_INT(safety_ack(&s, 7, 400 * MS), REFUSE_THROTTLE_HIGH);
    CHECK(safety_control(&s, 7, 3, &LOW, 410 * MS));
    safety_fc_flight_mode(&s, "!FS!", 405 * MS);                     /* FC still armed */
    CHECK_EQ_INT(safety_ack(&s, 7, 420 * MS), REFUSE_FC_STILL_ARMED);
    safety_fc_flight_mode(&s, "!FS!*", 430 * MS);                    /* FC disarmed */
    CHECK_EQ_INT(safety_ack(&s, 7, 440 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK_EQ_INT(s.fs_reason, FS_NONE);
    CHECK(!s.out.arm);
    CHECK(!s.out.failsafe);
}

static void test_stale_fc_report_does_not_block_ack(void)
{
    safety_t s;
    armed(&s);
    safety_fc_flight_mode(&s, "ACRO", 0);
    safety_trigger(&s, FS_MANUAL);
    CHECK(safety_control(&s, 7, 2, &LOW, 3100 * MS));
    CHECK_EQ_INT(safety_ack(&s, 7, 3100 * MS), REFUSE_NONE);    /* report older than 3 s */
}

static void test_ack_outside_failsafe_is_refused(void)
{
    safety_t s;
    armed(&s);
    CHECK_EQ_INT(safety_ack(&s, 7, 0), REFUSE_NOT_IN_FAILSAFE);
}

static void test_rearm_after_ack_needs_explicit_arm(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    CHECK(safety_control(&s, 7, 2, &LOW, 10 * MS));
    CHECK_EQ_INT(safety_ack(&s, 7, 10 * MS), REFUSE_NONE);
    CHECK(!s.out.arm);
    CHECK_EQ_INT(safety_arm(&s, 7, 10 * MS), REFUSE_NONE);
    CHECK(s.out.arm);
}

static void test_disarm(void)
{
    safety_t s;
    armed(&s);
    safety_disarm(&s);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.arm);

    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    safety_disarm(&s);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);   /* still latched */
    CHECK(!s.out.arm);
    CHECK(s.out.failsafe);
}

static void test_manual_failsafe_from_disarmed(void)
{
    safety_t s;
    setup(&s);
    safety_trigger(&s, FS_MANUAL);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK(s.out.failsafe);
    CHECK(!s.out.arm);
}

static void test_flight_mode_parsing(void)
{
    safety_t s;
    setup(&s);
    safety_fc_flight_mode(&s, "ACRO*", 0);
    CHECK_EQ_INT(s.fc_arm, FC_DISARMED);
    safety_fc_flight_mode(&s, "AIR", 0);
    CHECK_EQ_INT(s.fc_arm, FC_ARMED);
    safety_fc_flight_mode(&s, "", 0);
    CHECK_EQ_INT(s.fc_arm, FC_UNKNOWN);
}

static void test_names(void)
{
    CHECK_STR(safety_state_name(SAFETY_FAILSAFE), "FAILSAFE");
    CHECK_STR(safety_reason_name(FS_CMD_TIMEOUT), "cmd_timeout");
    CHECK_STR(safety_refuse_name(REFUSE_FC_STILL_ARMED), "fc_still_armed");
}

int main(void)
{
    RUN(test_starts_disarmed_with_safe_outputs);
    RUN(test_commands_need_the_current_session);
    RUN(test_old_or_repeated_sequence_numbers_are_ignored);
    RUN(test_values_are_clamped);
    RUN(test_arm_refusals);
    RUN(test_timeout_boundary);
    RUN(test_failsafe_outputs);
    RUN(test_commands_in_failsafe_refresh_link_but_not_sticks);
    RUN(test_disarmed_timeout_does_not_latch);
    RUN(test_pilot_lost_while_armed);
    RUN(test_gateway_lost_while_armed);
    RUN(test_new_session_while_armed);
    RUN(test_first_failsafe_reason_is_kept);
    RUN(test_ack_refusals_and_success);
    RUN(test_stale_fc_report_does_not_block_ack);
    RUN(test_ack_outside_failsafe_is_refused);
    RUN(test_rearm_after_ack_needs_explicit_arm);
    RUN(test_disarm);
    RUN(test_manual_failsafe_from_disarmed);
    RUN(test_flight_mode_parsing);
    RUN(test_names);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_safety.c:2:10: fatal error: safety.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/safety.h`:

```c
/* safety.h - arming and failsafe state machine. Pure logic: callers pass the time in.
 *
 * Rules:
 *  - Nothing upstream is trusted. Armed + no *fresh* command for timeout -> FAILSAFE.
 *    A command is fresh only if it belongs to the current session and its sequence
 *    number is higher than the last one applied.
 *  - FAILSAFE raises the FAILSAFE switch, centres the sticks and drops throttle, and
 *    leaves ARM as it was so Betaflight runs its own failsafe procedure.
 *  - FAILSAFE is latched. Only an explicit acknowledge clears it, and only while the
 *    link is fresh, throttle is low and the FC does not report itself armed. Clearing
 *    always ends DISARMED; flying again needs a new, explicit arm request. */
#ifndef SAFETY_H
#define SAFETY_H

#include <stdbool.h>
#include <stdint.h>
#include "chmap.h"

typedef enum { SAFETY_DISARMED = 0, SAFETY_ARMED = 1, SAFETY_FAILSAFE = 2 } safety_state_t;

typedef enum {
    FS_NONE = 0,
    FS_CMD_TIMEOUT,      /* armed and no fresh command for the timeout */
    FS_PILOT_LOST,       /* the gateway reported the pilot's connection closed */
    FS_GATEWAY_LOST,     /* the gateway's connection to the core closed */
    FS_SESSION_CHANGED,  /* a different pilot session started while armed */
    FS_MANUAL,           /* the pilot pressed FAILSAFE */
} fs_reason_t;

typedef enum { FC_UNKNOWN = 0, FC_DISARMED = 1, FC_ARMED = 2 } fc_arm_t;

typedef enum {
    REFUSE_NONE = 0,
    REFUSE_WRONG_SESSION,
    REFUSE_NOT_DISARMED,
    REFUSE_NOT_IN_FAILSAFE,
    REFUSE_LINK_STALE,
    REFUSE_THROTTLE_HIGH,
    REFUSE_FC_STILL_ARMED,
} refuse_t;

typedef struct {
    int16_t roll, pitch, yaw;  /* -1000..1000 */
    uint16_t throttle;         /* 0..1000 */
    uint8_t mode;              /* 0..2 */
} stick_cmd_t;

typedef struct {
    int64_t timeout_ns;
    int64_t fc_fresh_ns;
    uint16_t throttle_arm_max;

    safety_state_t state;
    fs_reason_t fs_reason;
    uint32_t session;          /* current pilot session; 0 = none */
    uint32_t last_seq;
    bool have_cmd;
    int64_t last_cmd_ns;
    stick_cmd_t cmd;           /* last command the pilot sent (clamped) */
    fc_arm_t fc_arm;
    int64_t fc_arm_ns;
    rc_outputs_t out;          /* what goes on the air */
} safety_t;

void safety_init(safety_t *s, int64_t timeout_ns, int64_t fc_fresh_ns, uint16_t throttle_arm_max);
bool safety_link_fresh(const safety_t *s, int64_t now);

/* A pilot took control. If armed, that is a failsafe (FS_SESSION_CHANGED). */
void safety_session_start(safety_t *s, uint32_t session);
/* Returns true if the command was fresh and applied. */
bool safety_control(safety_t *s, uint32_t session, uint32_t seq, const stick_cmd_t *cmd, int64_t now);
refuse_t safety_arm(safety_t *s, uint32_t session, int64_t now);
/* Always allowed. In FAILSAFE it drops ARM but keeps the failsafe latched. */
void safety_disarm(safety_t *s);
refuse_t safety_ack(safety_t *s, uint32_t session, int64_t now);
void safety_pilot_lost(safety_t *s, uint32_t session);
void safety_gateway_lost(safety_t *s);
/* Enter FAILSAFE from any state (keeps the first reason if already in FAILSAFE). */
void safety_trigger(safety_t *s, fs_reason_t reason);
/* Betaflight appends '*' to its flight-mode string while disarmed. */
void safety_fc_flight_mode(safety_t *s, const char *mode, int64_t now);
void safety_tick(safety_t *s, int64_t now);

const char *safety_state_name(safety_state_t st);
const char *safety_reason_name(fs_reason_t r);
const char *safety_refuse_name(refuse_t r);

#endif
```

Create `core/src/safety.c`:

```c
#include "safety.h"

#include <string.h>

static int clampi(int v, int lo, int hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

static void apply_sticks(safety_t *s)
{
    s->out.roll = s->cmd.roll;
    s->out.pitch = s->cmd.pitch;
    s->out.yaw = s->cmd.yaw;
    s->out.throttle = s->cmd.throttle;
    s->out.mode = s->cmd.mode;
}

static void enter_failsafe(safety_t *s, fs_reason_t reason)
{
    if (s->state == SAFETY_FAILSAFE)
        return;
    s->state = SAFETY_FAILSAFE;
    s->fs_reason = reason;
    s->out.failsafe = true;
    s->out.roll = s->out.pitch = s->out.yaw = 0;
    s->out.throttle = 0;
    /* out.arm unchanged: Betaflight decides what happens next (drop, land, rescue). */
}

void safety_init(safety_t *s, int64_t timeout_ns, int64_t fc_fresh_ns, uint16_t throttle_arm_max)
{
    memset(s, 0, sizeof *s);
    s->timeout_ns = timeout_ns;
    s->fc_fresh_ns = fc_fresh_ns;
    s->throttle_arm_max = throttle_arm_max;
    s->state = SAFETY_DISARMED;
}

bool safety_link_fresh(const safety_t *s, int64_t now)
{
    return s->have_cmd && now - s->last_cmd_ns <= s->timeout_ns;
}

void safety_session_start(safety_t *s, uint32_t session)
{
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_SESSION_CHANGED);
    s->session = session;
    s->last_seq = 0;
    s->have_cmd = false;
}

bool safety_control(safety_t *s, uint32_t session, uint32_t seq, const stick_cmd_t *cmd, int64_t now)
{
    if (session == 0 || session != s->session || seq <= s->last_seq)
        return false;
    s->last_seq = seq;
    s->have_cmd = true;
    s->last_cmd_ns = now;
    s->cmd.roll = (int16_t)clampi(cmd->roll, -1000, 1000);
    s->cmd.pitch = (int16_t)clampi(cmd->pitch, -1000, 1000);
    s->cmd.yaw = (int16_t)clampi(cmd->yaw, -1000, 1000);
    s->cmd.throttle = (uint16_t)clampi(cmd->throttle, 0, 1000);
    s->cmd.mode = (uint8_t)clampi(cmd->mode, 0, 2);
    if (s->state != SAFETY_FAILSAFE)
        apply_sticks(s);
    return true;
}

refuse_t safety_arm(safety_t *s, uint32_t session, int64_t now)
{
    if (session == 0 || session != s->session)
        return REFUSE_WRONG_SESSION;
    if (s->state != SAFETY_DISARMED)
        return REFUSE_NOT_DISARMED;
    if (!safety_link_fresh(s, now))
        return REFUSE_LINK_STALE;
    if (s->cmd.throttle > s->throttle_arm_max)
        return REFUSE_THROTTLE_HIGH;
    s->state = SAFETY_ARMED;
    s->out.arm = true;
    return REFUSE_NONE;
}

void safety_disarm(safety_t *s)
{
    s->out.arm = false;
    if (s->state == SAFETY_ARMED)
        s->state = SAFETY_DISARMED;
}

refuse_t safety_ack(safety_t *s, uint32_t session, int64_t now)
{
    if (session == 0 || session != s->session)
        return REFUSE_WRONG_SESSION;
    if (s->state != SAFETY_FAILSAFE)
        return REFUSE_NOT_IN_FAILSAFE;
    if (!safety_link_fresh(s, now))
        return REFUSE_LINK_STALE;
    if (s->cmd.throttle > s->throttle_arm_max)
        return REFUSE_THROTTLE_HIGH;
    if (s->fc_arm == FC_ARMED && now - s->fc_arm_ns <= s->fc_fresh_ns)
        return REFUSE_FC_STILL_ARMED;
    s->state = SAFETY_DISARMED;
    s->fs_reason = FS_NONE;
    s->out.failsafe = false;
    s->out.arm = false;
    apply_sticks(s);
    return REFUSE_NONE;
}

void safety_pilot_lost(safety_t *s, uint32_t session)
{
    if (session == 0 || session != s->session)
        return;
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_PILOT_LOST);
    s->session = 0;            /* late messages from that session are ignored */
    s->have_cmd = false;
}

void safety_gateway_lost(safety_t *s)
{
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_GATEWAY_LOST);
    s->session = 0;
    s->have_cmd = false;
}

void safety_trigger(safety_t *s, fs_reason_t reason)
{
    enter_failsafe(s, reason);
}

void safety_fc_flight_mode(safety_t *s, const char *mode, int64_t now)
{
    size_t n = strlen(mode);
    s->fc_arm = n == 0 ? FC_UNKNOWN : mode[n - 1] == '*' ? FC_DISARMED : FC_ARMED;
    s->fc_arm_ns = now;
}

void safety_tick(safety_t *s, int64_t now)
{
    if (s->state == SAFETY_ARMED && !safety_link_fresh(s, now))
        enter_failsafe(s, FS_CMD_TIMEOUT);
}

const char *safety_state_name(safety_state_t st)
{
    switch (st) {
    case SAFETY_DISARMED: return "DISARMED";
    case SAFETY_ARMED: return "ARMED";
    case SAFETY_FAILSAFE: return "FAILSAFE";
    }
    return "?";
}

const char *safety_reason_name(fs_reason_t r)
{
    switch (r) {
    case FS_NONE: return "none";
    case FS_CMD_TIMEOUT: return "cmd_timeout";
    case FS_PILOT_LOST: return "pilot_lost";
    case FS_GATEWAY_LOST: return "gateway_lost";
    case FS_SESSION_CHANGED: return "session_changed";
    case FS_MANUAL: return "manual";
    }
    return "?";
}

const char *safety_refuse_name(refuse_t r)
{
    switch (r) {
    case REFUSE_NONE: return "none";
    case REFUSE_WRONG_SESSION: return "wrong_session";
    case REFUSE_NOT_DISARMED: return "not_disarmed";
    case REFUSE_NOT_IN_FAILSAFE: return "not_in_failsafe";
    case REFUSE_LINK_STALE: return "link_stale";
    case REFUSE_THROTTLE_HIGH: return "throttle_high";
    case REFUSE_FC_STILL_ARMED: return "fc_still_armed";
    }
    return "?";
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/safety.c core/src/safety.h core/tests/test_safety.c
git commit -m "core: arming and failsafe state machine"
```

## Done when

- `make -C core test` passes (69 unit tests) and `make -C core integration` still passes.
- A teammate has reviewed `safety.c` against spec §5.3. It decides what the aircraft does when links fail.
