# M1: CRSF Protocol Library and Module Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A unit-tested C library for the CRSF protocol plus two tools: `crsf-probe` (does the BetaFPV module answer over USB, with which firmware?) and `crsf-param` (read and change ELRS settings without a radio).

**Architecture:** Small C modules under `core/src`, each with one job (CRC, frames, stream splitting, telemetry decoding, serial port, parameter protocol), linked into tools by one Makefile. Unit tests are tiny programs; integration tests run the real tools against an independent Python fake TX module on a pseudo-terminal. The last task checks the real module.

**Tech Stack:** C (gnu11), GNU make, Linux termios2, Python 3 `unittest` + pty for the fake module.

**Spec:** `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (read it first; section numbers below refer to it)

**Before you start:** Read spec §2 (D1–D3), §4.4 and §9. The repository already exists and holds `docs/` (spec and plans): `cd ~/ProyectoTerminal/elrs-web-gcs && git status` must say the tree is clean. Tasks 1–8 need no hardware; Task 9 needs the BetaFPV module on the Pi's USB (and, for one step, the drone with its receiver, propellers off).

## Global Constraints

- Work in `~/ProyectoTerminal/elrs-web-gcs` on branch `main`; run every command from the repository root.
- Target: Raspberry Pi 4, Debian 13 arm64, gcc 14 (`-std=gnu11`), GNU make, Python 3.13 standard library only.
- Every file below was compiled and tested on that Pi before this plan was written: type it exactly. If a step's output differs from **Expected**, stop and find out why; do not edit a test to make it pass.
- **Propellers off** for every step that touches real hardware.
- Expected output is quoted in English; tools print some messages (compiler, `make`, Python errors) in the system's language.
- C flags `-std=gnu11 -Wall -Wextra -Werror -Wshadow -Wstrict-prototypes`; unit tests add UBSan (`-fsanitize=undefined`). AddressSanitizer does not work with this Pi's kernel: do not add it.
- CRSF frame CRC: polynomial 0xD5 over type..payload. The inner CRC of command frames (0x32): polynomial 0xBA, MSB first, init 0, the way EdgeTX computes it (the Go reference reflects it; ELRS does not check it).
- RC frame: `EE 18 16`, then 16 channels × 11 bits packed LSB first, then the CRC. Channel values 172–1811, centre 992 (1500 µs).
- Serial port: raw 8N1, non-blocking, any baud via termios2/BOTHER, exclusive (TIOCEXCL). Default 921600 baud.
- The fake module (`core/tests/integration/fake_tx.py`) is an independent Python implementation of the protocol. Never make it reuse C code: the two implementations check each other.

## Review Focus

Inputs and failure modes most likely to hurt a real user; each is pinned by a test in the task named.

1. The module does not answer (wrong baud, CRSF not routed to USB) → `crsf-probe` exits 1 with `no CRSF device answered` instead of hanging (Task 7, `test_no_answer_exits_one`).
2. Noise, partial frames and bad CRCs on the line → the deframer never overflows and resynchronises (Task 3, `test_long_noise_never_overflows`, `test_bad_crc_is_rejected_and_stream_recovers`).
3. A second program opens the port (`crsf-param` while crsf-core runs) → refused with EBUSY, never two writers (Task 5, `test_second_open_is_refused`).
4. ELRS resends a parameter chunk after a retried request → the duplicate is rejected and the setting is not corrupted (Task 6, `test_repeated_chunk_is_rejected`).
5. Overlong or unterminated strings from the aircraft → truncated safely (Task 4, `test_long_device_name_is_truncated`, `test_flight_mode_is_truncated_safely`, `test_wrong_lengths_are_rejected`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `README.md` | project overview, layout, how to run every test suite |
| `.gitignore` | build outputs, node_modules, Python caches |
| `core/Makefile` | builds `src/*.c` into the tools (and later the daemon); `test`, `integration`, `install` |
| `core/tests/check.h` | minimal assertion macros for C unit tests |
| `core/src/timeutil.h` | CLOCK_MONOTONIC helpers |
| `core/src/crc8.{h,c}` | CRC-8 with polynomials 0xD5 and 0xBA |
| `core/src/crsf.{h,c}` | protocol constants, µs ↔ channel value, RC / ping / model-select frames |
| `core/src/crsf_deframer.{h,c}` | serial byte stream → CRC-checked frames |
| `core/src/crsf_telem.{h,c}` | decode link statistics, battery, flight mode, timing, device info |
| `core/src/serial.{h,c}` | open a serial port: raw, any baud, exclusive |
| `core/src/crsf_param.{h,c}` | ELRS parameter (Lua menu) protocol |
| `core/tools/crsf-probe.c` | check that the module answers; print what it reports |
| `core/tools/crsf-param.c` | list and change module settings |
| `core/tests/test_*.c` | unit tests, one program per module |
| `core/tests/integration/fake_tx.py` | Python fake TX module on a pseudo-terminal |
| `core/tests/integration/test_probe.py, test_param.py` | integration tests for the tools |
| `docs/setup/module.md` | one-time module setup, recommended settings, firmware version record |

### Task 1: Repository skeleton and CRC-8

The Makefile compiles every `src/*.c` except `main.c` into a library used by every tool and test, so later tasks only add files. `make test` builds each `tests/test_*.c` with UBSan and runs it.

**Files:**
- Create: `README.md`
- Create: `.gitignore`
- Create: `core/Makefile`
- Create: `core/src/timeutil.h`
- Create: `core/src/crc8.h`
- Create: `core/src/crc8.c`
- Test: `core/tests/check.h`
- Test: `core/tests/test_crc8.c`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `uint8_t crc8_d5(const uint8_t *data, size_t len)`, `uint8_t crc8_ba(const uint8_t *data, size_t len)`; test macros `CHECK`, `CHECK_EQ_INT`, `CHECK_MEM`, `CHECK_STR`, `RUN`, `CHECK_EXIT` (check.h); `int64_t mono_ns(void)`, `struct timespec ns_to_timespec(int64_t)`, `NS_PER_US/MS/S` (timeutil.h)

- [ ] **Step 1: Add the README and .gitignore**

Create `README.md`:

````markdown
# elrs-web-gcs

Web ground control station for ExpressLRS drones. A pilot's browser (PC or Android)
flies the drone through a Raspberry Pi 4 and an ELRS TX module, with local video for
several viewers and an optional internet relay.
Proyecto Terminal de Ingeniería, Universidad Iberoamericana, Otoño 2026, Equipo 1.

```
browser ──HTTPS/WebSocket──▶ gateway (Node.js) ──Unix socket──▶ crsf-core (C, real-time)
                                                                    │ USB (CRSF)
                                                         BetaFPV ELRS TX ──RF──▶ ELRS RX + Betaflight
```

| Directory | Contents | Milestone |
|-----------|----------|-----------|
| `core/` | crsf-core daemon and the crsf-probe, crsf-param, crsf-ctl tools (C) | M1–M3 |
| `gateway/` | HTTPS + WebSocket gateway (Node.js) | M4, M6, M7 |
| `web/` | pilot page, video page (plain HTML/JS, no build step) | M4, M6, M7 |
| `tools/` | measurement tools for criteria C1–C4 and the relay | M5–M7 |
| `relay/` | internet relay (Node.js, experimental) | M7 |
| `deploy/` | configs, systemd units, install scripts | M3, M4, M6, M7 |
| `docs/` | design, plans, setup guides, test procedures | all |

Design: `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md`.
Plans, one per milestone: `docs/superpowers/plans/`.

## Tests

```bash
make -C core test                         # C unit tests (UBSan)
make -C core integration                  # C programs against a fake TX module on a pseudo-terminal
(cd gateway && npm ci && npm test)        # gateway and web unit + integration tests
                                          # (from M7 on, run `(cd relay && npm ci)` first)
(cd gateway && npm run e2e)               # headless Firefox -> gateway -> crsf-core -> fake module
python3 -m unittest discover -s tools/analysis -t tools/analysis
(cd relay && npm ci && npm test)
```

## Safety

**Propellers off** for every bench test. Arming needs the throttle at zero and a deliberate
press-and-hold. Losing the pilot, the gateway or the browser's focus for 300 ms triggers
failsafe, and only an explicit acknowledge clears it. Real flights follow the test-site
rules agreed with the mentor, with the pilot in visual line of sight (never BVLOS).
````

Create `.gitignore`:

```text
core/build/
node_modules/
__pycache__/
*.pyc
```

- [ ] **Step 2: Add the build and test scaffolding**

Create `core/Makefile`:

```make
# crsf-core build. `make` builds the tools and daemon, `make test` runs the unit tests.
CC      ?= gcc
CFLAGS  ?= -O2 -g
CFLAGS  += -std=gnu11 -Wall -Wextra -Werror -Wshadow -Wstrict-prototypes -Isrc
LDLIBS  += -pthread
# AddressSanitizer does not work with this Raspberry Pi kernel's address space; UBSan does.
SAN     := -fsanitize=undefined -fno-sanitize-recover=undefined

BUILD   := build
LIB_SRC := $(filter-out src/main.c,$(wildcard src/*.c))
LIB_OBJ := $(LIB_SRC:src/%.c=$(BUILD)/obj/%.o)
SAN_OBJ := $(LIB_SRC:src/%.c=$(BUILD)/san/%.o)
HDRS    := $(wildcard src/*.h) $(wildcard tests/*.h)
TOOLS   := $(patsubst tools/%.c,$(BUILD)/%,$(wildcard tools/*.c))
DAEMON  := $(if $(wildcard src/main.c),$(BUILD)/crsf-core)
TESTS   := $(patsubst tests/%.c,$(BUILD)/tests/%,$(wildcard tests/test_*.c))
PREFIX  ?= /usr/local

.PHONY: all test install clean
all: $(TOOLS) $(DAEMON)

$(BUILD)/obj/%.o: src/%.c $(HDRS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/san/%.o: src/%.c $(HDRS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(SAN) -c $< -o $@

$(BUILD)/crsf-core: src/main.c $(LIB_OBJ)
	$(CC) $(CFLAGS) $^ -o $@ $(LDLIBS)

$(BUILD)/tests/%: tests/%.c $(SAN_OBJ)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(SAN) -Itests $^ -o $@ $(LDLIBS)

$(BUILD)/%: tools/%.c $(LIB_OBJ)
	$(CC) $(CFLAGS) $^ -o $@ $(LDLIBS)

test: $(TESTS)
	@for t in $(TESTS); do echo "== $$t"; ./$$t || exit 1; done
	@echo "ALL TESTS PASSED"

install: all
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 0755 $(TOOLS) $(DAEMON) $(DESTDIR)$(PREFIX)/bin/

clean:
	rm -rf $(BUILD)

.PHONY: integration
integration: all
	python3 -m unittest discover -s tests/integration -t tests/integration -v
```

Create `core/tests/check.h`:

```c
/* check.h - minimal unit-test helpers. Each tests/test_*.c is its own program. */
#ifndef CHECK_H
#define CHECK_H

#include <stdio.h>
#include <string.h>

static int check_failures;

#define CHECK(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        check_failures++; \
    } \
} while (0)

#define CHECK_EQ_INT(a, b) do { \
    long long check_a_ = (long long)(a), check_b_ = (long long)(b); \
    if (check_a_ != check_b_) { \
        fprintf(stderr, "%s:%d: CHECK_EQ_INT failed: %s == %s (%lld != %lld)\n", \
                __FILE__, __LINE__, #a, #b, check_a_, check_b_); \
        check_failures++; \
    } \
} while (0)

#define CHECK_MEM(a, b, n) do { \
    if (memcmp((a), (b), (n)) != 0) { \
        fprintf(stderr, "%s:%d: CHECK_MEM failed: %s vs %s\n", __FILE__, __LINE__, #a, #b); \
        check_failures++; \
    } \
} while (0)

#define CHECK_STR(a, b) do { \
    if (strcmp((a), (b)) != 0) { \
        fprintf(stderr, "%s:%d: CHECK_STR failed: \"%s\" != \"%s\"\n", __FILE__, __LINE__, (a), (b)); \
        check_failures++; \
    } \
} while (0)

#define RUN(test) do { \
    int check_before_ = check_failures; \
    test(); \
    printf("%s %s\n", check_failures == check_before_ ? "PASS" : "FAIL", #test); \
} while (0)

#define CHECK_EXIT() (check_failures == 0 ? 0 : 1)

#endif
```

Create `core/src/timeutil.h`:

```c
/* timeutil.h - CLOCK_MONOTONIC helpers shared by the core and the tools. */
#ifndef TIMEUTIL_H
#define TIMEUTIL_H

#include <stdint.h>
#include <time.h>

#define NS_PER_US 1000LL
#define NS_PER_MS 1000000LL
#define NS_PER_S  1000000000LL

static inline int64_t mono_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * NS_PER_S + ts.tv_nsec;
}

static inline struct timespec ns_to_timespec(int64_t ns)
{
    struct timespec ts = { .tv_sec = ns / NS_PER_S, .tv_nsec = ns % NS_PER_S };
    return ts;
}

#endif
```

- [ ] **Step 3: Write the failing test**

Create `core/tests/test_crc8.c`:

```c
#include "check.h"
#include "crc8.h"

static void test_d5_check_value(void)
{
    /* Published check value of CRC-8/DVB-S2 for "123456789". */
    CHECK_EQ_INT(crc8_d5((const uint8_t *)"123456789", 9), 0xBC);
}

static void test_ba_check_value(void)
{
    /* MSB-first, poly 0xBA, init 0 (EdgeTX crc8_BA). Computed by an independent implementation. */
    CHECK_EQ_INT(crc8_ba((const uint8_t *)"123456789", 9), 0x20);
}

static void test_empty_input_is_zero(void)
{
    CHECK_EQ_INT(crc8_d5(NULL, 0), 0);
    CHECK_EQ_INT(crc8_ba(NULL, 0), 0);
}

int main(void)
{
    RUN(test_d5_check_value);
    RUN(test_ba_check_value);
    RUN(test_empty_input_is_zero);
    return CHECK_EXIT();
}
```

- [ ] **Step 4: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_crc8.c:2:10: fatal error: crc8.h: No such file or directory`

- [ ] **Step 5: Write the implementation**

Create `core/src/crc8.h`:

```c
/* crc8.h - the two CRC-8 variants used by CRSF. */
#ifndef CRC8_H
#define CRC8_H

#include <stddef.h>
#include <stdint.h>

/* Frame CRC: polynomial 0xD5 (CRC-8/DVB-S2), over type byte .. last payload byte. */
uint8_t crc8_d5(const uint8_t *data, size_t len);

/* Inner CRC of CRSF command frames (type 0x32): polynomial 0xBA, as EdgeTX computes it. */
uint8_t crc8_ba(const uint8_t *data, size_t len);

#endif
```

Create `core/src/crc8.c`:

```c
#include "crc8.h"

static uint8_t crc8_poly(const uint8_t *data, size_t len, uint8_t poly)
{
    uint8_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++)
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ poly) : (uint8_t)(crc << 1);
    }
    return crc;
}

uint8_t crc8_d5(const uint8_t *data, size_t len)
{
    return crc8_poly(data, len, 0xD5);
}

uint8_t crc8_ba(const uint8_t *data, size_t len)
{
    return crc8_poly(data, len, 0xBA);
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: `PASS test_d5_check_value`, `PASS test_ba_check_value`, `PASS test_empty_input_is_zero`, then `ALL TESTS PASSED`

- [ ] **Step 7: Commit**

```bash
git add .gitignore README.md core/Makefile core/src/crc8.c core/src/crc8.h core/src/timeutil.h core/tests/check.h core/tests/test_crc8.c
git commit -m "core: build scaffolding and CRC-8 (0xD5, 0xBA)"
```

### Task 2: CRSF constants, channel values and the frames we send

The golden RC frames were produced by an independent Python implementation and, byte for byte, by `PackChannels()` of the elrs-joystick-control Go reference, which has flown with this module.

**Files:**
- Create: `core/src/crsf.h`
- Create: `core/src/crsf.c`
- Test: `core/tests/test_crsf.c`

**Interfaces:**
- Consumes: `crc8_d5`, `crc8_ba`
- Produces: `uint16_t crsf_us_to_ch(int us)`, `int crsf_ch_to_us(uint16_t)`, `void crsf_build_rc_frame(uint8_t out[26], const uint16_t ch[16])`, `void crsf_unpack_channels(const uint8_t payload[22], uint16_t ch[16])`, `size_t crsf_build_ping(uint8_t *out, size_t cap)`, `size_t crsf_build_model_select(uint8_t *out, size_t cap, uint8_t model_id)`; constants `CRSF_ADDR_*`, `CRSF_TYPE_*`, `CRSF_CH_MIN/MID/MAX`, `CRSF_NUM_CHANNELS`, `CRSF_RC_FRAME_LEN`, `CRSF_FRAME_MAX`

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_crsf.c`:

```c
#include "check.h"
#include "crsf.h"

/* Golden frames were produced by an independent Python implementation and, for the two
 * RC frames, also by PackChannels() from the kaack/elrs-joystick-control Go reference. */
static const uint8_t RC_CENTER[CRSF_RC_FRAME_LEN] = {
    0xEE, 0x18, 0x16, 0xE0, 0x03, 0x1F, 0xF8, 0xC0, 0x07, 0x3E, 0xF0, 0x81, 0x0F,
    0x7C, 0xE0, 0x03, 0x1F, 0xF8, 0xC0, 0x07, 0x3E, 0xF0, 0x81, 0x0F, 0x7C, 0xAD,
};
static const uint8_t RC_RAMP[CRSF_RC_FRAME_LEN] = {
    0xEE, 0x18, 0x16, 0xAC, 0xC8, 0x88, 0x61, 0xE6, 0x03, 0xA6, 0x66, 0xE9, 0xEC,
    0x74, 0x14, 0x0C, 0xA4, 0x3B, 0xB7, 0x8A, 0xDC, 0x1A, 0x8B, 0xFA, 0xE1, 0xE3,
};

static void ramp(uint16_t ch[CRSF_NUM_CHANNELS])
{
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = (uint16_t)(172 + i * 109);
}

static void test_us_to_ch_reference_points(void)
{
    CHECK_EQ_INT(crsf_us_to_ch(1500), 992);
    CHECK_EQ_INT(crsf_us_to_ch(1000), 192);
    CHECK_EQ_INT(crsf_us_to_ch(2000), 1792);
    CHECK_EQ_INT(crsf_us_to_ch(1001), 194);   /* 193.6 rounds up */
    CHECK_EQ_INT(crsf_us_to_ch(988), 173);    /* 172.8 rounds up */
}

static void test_us_to_ch_clamps(void)
{
    CHECK_EQ_INT(crsf_us_to_ch(500), CRSF_CH_MIN);
    CHECK_EQ_INT(crsf_us_to_ch(2500), CRSF_CH_MAX);
}

static void test_ch_to_us_reference_points(void)
{
    CHECK_EQ_INT(crsf_ch_to_us(992), 1500);
    CHECK_EQ_INT(crsf_ch_to_us(192), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(1792), 2000);
}

static void test_us_round_trip(void)
{
    for (int us = 1000; us <= 2000; us++)
        CHECK_EQ_INT(crsf_ch_to_us(crsf_us_to_ch(us)), us);
}

static void test_rc_frame_center_matches_golden(void)
{
    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = CRSF_CH_MID;
    crsf_build_rc_frame(frame, ch);
    CHECK_MEM(frame, RC_CENTER, sizeof RC_CENTER);
}

static void test_rc_frame_ramp_matches_golden(void)
{
    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    ramp(ch);
    crsf_build_rc_frame(frame, ch);
    CHECK_MEM(frame, RC_RAMP, sizeof RC_RAMP);
}

static void test_unpack_inverts_pack(void)
{
    uint16_t in[CRSF_NUM_CHANNELS], out[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    ramp(in);
    crsf_build_rc_frame(frame, in);
    crsf_unpack_channels(frame + 3, out);
    CHECK_MEM(in, out, sizeof in);
}

static void test_ping_frame(void)
{
    static const uint8_t expected[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
    uint8_t frame[8];
    CHECK_EQ_INT(crsf_build_ping(frame, sizeof frame), sizeof expected);
    CHECK_MEM(frame, expected, sizeof expected);
    CHECK_EQ_INT(crsf_build_ping(frame, 5), 0);
}

static void test_model_select_frame(void)
{
    static const uint8_t expected[] = { 0xC8, 0x08, 0x32, 0xEE, 0xEA, 0x10, 0x05, 0x00, 0xDC, 0x4D };
    uint8_t frame[16];
    CHECK_EQ_INT(crsf_build_model_select(frame, sizeof frame, 0), sizeof expected);
    CHECK_MEM(frame, expected, sizeof expected);
    CHECK_EQ_INT(crsf_build_model_select(frame, 9, 0), 0);
}

int main(void)
{
    RUN(test_us_to_ch_reference_points);
    RUN(test_us_to_ch_clamps);
    RUN(test_ch_to_us_reference_points);
    RUN(test_us_round_trip);
    RUN(test_rc_frame_center_matches_golden);
    RUN(test_rc_frame_ramp_matches_golden);
    RUN(test_unpack_inverts_pack);
    RUN(test_ping_frame);
    RUN(test_model_select_frame);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_crsf.c:2:10: fatal error: crsf.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/crsf.h`:

```c
/* crsf.h - CRSF protocol constants, channel conversion and the frames we send. */
#ifndef CRSF_H
#define CRSF_H

#include <stddef.h>
#include <stdint.h>

#define CRSF_ADDR_SYNC      0xC8  /* flight-controller address, also used as a generic sync byte */
#define CRSF_ADDR_HANDSET   0xEA  /* the "radio" side of the link: this program */
#define CRSF_ADDR_MODULE    0xEE  /* the ELRS TX module */

#define CRSF_TYPE_BATTERY      0x08
#define CRSF_TYPE_LINK_STATS   0x14
#define CRSF_TYPE_RC_CHANNELS  0x16
#define CRSF_TYPE_FLIGHT_MODE  0x21
#define CRSF_TYPE_PING         0x28
#define CRSF_TYPE_DEVICE_INFO  0x29
#define CRSF_TYPE_COMMAND      0x32
#define CRSF_TYPE_RADIO_ID     0x3A
#define CRSF_RADIO_ID_TIMING   0x10  /* "OpenTX sync" timing frame inside RADIO_ID */

#define CRSF_FRAME_MAX       64     /* whole frame: address + length + type + payload + CRC */
#define CRSF_NUM_CHANNELS    16
#define CRSF_RC_FRAME_LEN    26
#define CRSF_CH_MIN          172    /* ~988 us */
#define CRSF_CH_MID          992    /* 1500 us */
#define CRSF_CH_MAX          1811   /* ~2012 us */

/* Pulse width in microseconds -> CRSF channel value (rounded, clamped to MIN..MAX). */
uint16_t crsf_us_to_ch(int us);
/* CRSF channel value -> pulse width in microseconds (rounded). */
int crsf_ch_to_us(uint16_t ch);

/* RC_CHANNELS_PACKED frame addressed to the TX module: 16 x 11-bit values, LSB first. */
void crsf_build_rc_frame(uint8_t out[CRSF_RC_FRAME_LEN], const uint16_t ch[CRSF_NUM_CHANNELS]);
/* Inverse of the packing above; payload points at the 22 bytes after the type byte. */
void crsf_unpack_channels(const uint8_t payload[22], uint16_t ch[CRSF_NUM_CHANNELS]);

/* Device ping (broadcast). Every CRSF device answers with DEVICE_INFO. Returns length or 0. */
size_t crsf_build_ping(uint8_t *out, size_t cap);
/* "Model select" command: ELRS loads that model slot's settings. Returns length or 0. */
size_t crsf_build_model_select(uint8_t *out, size_t cap, uint8_t model_id);

#endif
```

Create `core/src/crsf.c`:

```c
#include "crsf.h"
#include "crc8.h"

uint16_t crsf_us_to_ch(int us)
{
    /* ch = 992 + (us - 1500) * 1.6, rounded half away from zero */
    long num = (long)(us - 1500) * 16;
    long q = num >= 0 ? (num + 5) / 10 : -((-num + 5) / 10);
    long ch = CRSF_CH_MID + q;
    if (ch < CRSF_CH_MIN)
        ch = CRSF_CH_MIN;
    if (ch > CRSF_CH_MAX)
        ch = CRSF_CH_MAX;
    return (uint16_t)ch;
}

int crsf_ch_to_us(uint16_t ch)
{
    /* us = 1500 + (ch - 992) * 0.625, rounded half away from zero */
    long num = ((long)ch - CRSF_CH_MID) * 5;
    long q = num >= 0 ? (num + 4) / 8 : -((-num + 4) / 8);
    return (int)(1500 + q);
}

void crsf_build_rc_frame(uint8_t out[CRSF_RC_FRAME_LEN], const uint16_t ch[CRSF_NUM_CHANNELS])
{
    out[0] = CRSF_ADDR_MODULE;
    out[1] = 24;                    /* type + 22 payload bytes + CRC */
    out[2] = CRSF_TYPE_RC_CHANNELS;

    uint32_t bits = 0;
    int nbits = 0;
    size_t o = 3;
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++) {
        bits |= (uint32_t)(ch[i] & 0x7FF) << nbits;
        nbits += 11;
        while (nbits >= 8) {
            out[o++] = (uint8_t)(bits & 0xFF);
            bits >>= 8;
            nbits -= 8;
        }
    }
    out[25] = crc8_d5(out + 2, 23);
}

void crsf_unpack_channels(const uint8_t payload[22], uint16_t ch[CRSF_NUM_CHANNELS])
{
    uint32_t bits = 0;
    int nbits = 0;
    size_t in = 0;
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++) {
        while (nbits < 11) {
            bits |= (uint32_t)payload[in++] << nbits;
            nbits += 8;
        }
        ch[i] = (uint16_t)(bits & 0x7FF);
        bits >>= 11;
        nbits -= 11;
    }
}

size_t crsf_build_ping(uint8_t *out, size_t cap)
{
    if (cap < 6)
        return 0;
    out[0] = CRSF_ADDR_MODULE;
    out[1] = 4;                     /* type + destination + origin + CRC */
    out[2] = CRSF_TYPE_PING;
    out[3] = 0x00;                  /* destination: broadcast */
    out[4] = CRSF_ADDR_HANDSET;     /* origin: answers come back to us */
    out[5] = crc8_d5(out + 2, 3);
    return 6;
}

size_t crsf_build_model_select(uint8_t *out, size_t cap, uint8_t model_id)
{
    if (cap < 10)
        return 0;
    out[0] = CRSF_ADDR_SYNC;
    out[1] = 8;
    out[2] = CRSF_TYPE_COMMAND;
    out[3] = CRSF_ADDR_MODULE;      /* destination */
    out[4] = CRSF_ADDR_HANDSET;     /* origin */
    out[5] = 0x10;                  /* sub-command group: CRSF */
    out[6] = 0x05;                  /* command: model select */
    out[7] = model_id;
    out[8] = crc8_ba(out + 2, 6);   /* inner command CRC */
    out[9] = crc8_d5(out + 2, 7);   /* frame CRC covers the inner CRC too */
    return 10;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/crsf.c core/src/crsf.h core/tests/test_crsf.c
git commit -m "core: CRSF frames and channel conversion"
```

### Task 3: Stream deframer

**Files:**
- Create: `core/src/crsf_deframer.h`
- Create: `core/src/crsf_deframer.c`
- Test: `core/tests/test_deframer.c`

**Interfaces:**
- Consumes: `crc8_d5`, CRSF constants
- Produces: `crsf_deframer_t` (counters `frames`, `crc_errors`, `dropped_bytes`), `void crsf_deframer_init(crsf_deframer_t *)`, `void crsf_deframer_feed(crsf_deframer_t *, const uint8_t *data, size_t n, crsf_frame_cb cb, void *user)`, `typedef void (*crsf_frame_cb)(const uint8_t *frame, size_t len, void *user)`

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_deframer.c`:

```c
#include "check.h"
#include "crsf_deframer.h"

static const uint8_t PING[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
static const uint8_t FLIGHT_MODE[] = { 0xEA, 0x08, 0x21, 0x41, 0x43, 0x52, 0x4F, 0x2A, 0x00, 0x14 };

typedef struct {
    int count;
    size_t lens[8];
    uint8_t first_types[8];
} seen_t;

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    seen_t *s = user;
    if (s->count < 8) {
        s->lens[s->count] = len;
        s->first_types[s->count] = frame[2];
    }
    s->count++;
}

static void test_single_frame(void)
{
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK_EQ_INT(s.lens[0], sizeof PING);
    CHECK_EQ_INT(d.frames, 1);
}

static void test_frame_split_across_reads(void)
{
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    for (size_t i = 0; i < sizeof FLIGHT_MODE; i++)
        crsf_deframer_feed(&d, FLIGHT_MODE + i, 1, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK_EQ_INT(s.first_types[0], 0x21);
}

static void test_garbage_before_and_between_frames(void)
{
    uint8_t stream[64];
    size_t n = 0;
    stream[n++] = 0x00;
    stream[n++] = 0x13;
    memcpy(stream + n, PING, sizeof PING); n += sizeof PING;
    stream[n++] = 0x55;
    memcpy(stream + n, FLIGHT_MODE, sizeof FLIGHT_MODE); n += sizeof FLIGHT_MODE;

    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, stream, n, on_frame, &s);
    CHECK_EQ_INT(s.count, 2);
    CHECK_EQ_INT(s.first_types[0], 0x28);
    CHECK_EQ_INT(s.first_types[1], 0x21);
    CHECK_EQ_INT(d.dropped_bytes, 3);
}

static void test_bad_crc_is_rejected_and_stream_recovers(void)
{
    uint8_t stream[32];
    memcpy(stream, PING, sizeof PING);
    stream[5] ^= 0xFF;                               /* corrupt CRC */
    memcpy(stream + sizeof PING, PING, sizeof PING); /* followed by a good frame */

    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, stream, 2 * sizeof PING, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK_EQ_INT(d.crc_errors, 1);
}

static void test_impossible_length_is_skipped(void)
{
    static const uint8_t bad[] = { 0xEA, 0xFF, 0xEA, 0x01 };
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, bad, sizeof bad, on_frame, &s);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK(d.dropped_bytes >= 3);
}

static void test_long_noise_never_overflows(void)
{
    uint8_t noise[4096];
    for (size_t i = 0; i < sizeof noise; i++)
        noise[i] = (uint8_t)(i * 37u + 11u);         /* includes many fake start bytes */
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, noise, sizeof noise, on_frame, &s);
    CHECK(d.len < CRSF_FRAME_MAX);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    CHECK(s.count >= 1);                             /* recovers once noise stops */
}

int main(void)
{
    RUN(test_single_frame);
    RUN(test_frame_split_across_reads);
    RUN(test_garbage_before_and_between_frames);
    RUN(test_bad_crc_is_rejected_and_stream_recovers);
    RUN(test_impossible_length_is_skipped);
    RUN(test_long_noise_never_overflows);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_deframer.c:2:10: fatal error: crsf_deframer.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/crsf_deframer.h`:

```c
/* crsf_deframer.h - split a serial byte stream into CRC-checked CRSF frames. */
#ifndef CRSF_DEFRAMER_H
#define CRSF_DEFRAMER_H

#include <stddef.h>
#include <stdint.h>
#include "crsf.h"

/* Called once per valid frame. `frame` is only valid during the call; do not call
 * crsf_deframer_feed() from inside the callback. */
typedef void (*crsf_frame_cb)(const uint8_t *frame, size_t len, void *user);

typedef struct {
    uint8_t buf[CRSF_FRAME_MAX];
    size_t len;
    uint32_t frames;         /* valid frames delivered */
    uint32_t crc_errors;     /* candidate frames rejected by CRC */
    uint32_t dropped_bytes;  /* bytes skipped while searching for a frame start */
} crsf_deframer_t;

void crsf_deframer_init(crsf_deframer_t *d);
void crsf_deframer_feed(crsf_deframer_t *d, const uint8_t *data, size_t n,
                        crsf_frame_cb cb, void *user);

#endif
```

Create `core/src/crsf_deframer.c`:

```c
#include "crsf_deframer.h"
#include "crc8.h"
#include <string.h>

static int is_frame_start(uint8_t b)
{
    return b == CRSF_ADDR_HANDSET || b == CRSF_ADDR_MODULE || b == CRSF_ADDR_SYNC;
}

static void drop_front(crsf_deframer_t *d, size_t n)
{
    memmove(d->buf, d->buf + n, d->len - n);
    d->len -= n;
}

void crsf_deframer_init(crsf_deframer_t *d)
{
    memset(d, 0, sizeof *d);
}

void crsf_deframer_feed(crsf_deframer_t *d, const uint8_t *data, size_t n,
                        crsf_frame_cb cb, void *user)
{
    for (size_t i = 0; i < n; i++) {
        /* Invariant: d->len < CRSF_FRAME_MAX here, because a buffer holding a whole
         * frame is always consumed below before the next byte is appended. */
        d->buf[d->len++] = data[i];
        for (;;) {
            if (d->len == 0)
                break;
            if (!is_frame_start(d->buf[0])) {
                drop_front(d, 1);
                d->dropped_bytes++;
                continue;
            }
            if (d->len < 2)
                break;
            size_t flen = d->buf[1];              /* bytes after the length byte */
            if (flen < 2 || flen > CRSF_FRAME_MAX - 2) {
                drop_front(d, 1);
                d->dropped_bytes++;
                continue;
            }
            size_t total = flen + 2;
            if (d->len < total)
                break;
            if (crc8_d5(d->buf + 2, flen - 1) != d->buf[total - 1]) {
                drop_front(d, 1);                 /* resync on the next start byte */
                d->crc_errors++;
                continue;
            }
            d->frames++;
            cb(d->buf, total, user);
            drop_front(d, total);
        }
    }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/crsf_deframer.c core/src/crsf_deframer.h core/tests/test_deframer.c
git commit -m "core: split the serial stream into CRC-checked frames"
```

### Task 4: Telemetry decoder

**Files:**
- Create: `core/src/crsf_telem.h`
- Create: `core/src/crsf_telem.c`
- Test: `core/tests/test_telem.c`

**Interfaces:**
- Consumes: frames from the deframer
- Produces: `crsf_msg_kind_t crsf_decode(const uint8_t *frame, size_t len, crsf_msg_t *out)` with `crsf_link_stats_t`, `crsf_battery_t`, `crsf_flight_mode_t`, `crsf_timing_t` (`interval_0p1us`, `offset_0p1us`), `crsf_device_info_t`, and `CRSF_MSG_*` kinds

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_telem.c`:

```c
#include "check.h"
#include "crsf_telem.h"

/* Golden frames from an independent Python implementation (see plan M1). */
static const uint8_t LINK[] = { 0xEA, 0x0C, 0x14, 0xBD, 0xBA, 0x64, 0x09, 0x01, 0x07, 0x03,
                                0xC9, 0x62, 0xFC, 0x8C };
static const uint8_t BATTERY[] = { 0xEA, 0x0A, 0x08, 0x00, 0xA8, 0x00, 0x2D, 0x00, 0x04, 0xD2,
                                   0x57, 0x96 };
static const uint8_t FLIGHT_MODE[] = { 0xEA, 0x08, 0x21, 0x41, 0x43, 0x52, 0x4F, 0x2A, 0x00, 0x14 };
static const uint8_t TIMING[] = { 0xEA, 0x0D, 0x3A, 0xEA, 0xEE, 0x10, 0x00, 0x00, 0x9C, 0x40,
                                  0xFF, 0xFF, 0xFB, 0x2E, 0xAA };
static const uint8_t DEVICE[] = { 0xEA, 0x1D, 0x29, 0xEA, 0xEE, 0x42, 0x45, 0x54, 0x41, 0x46,
                                  0x50, 0x56, 0x20, 0x31, 0x57, 0x00, 0x45, 0x4C, 0x52, 0x53,
                                  0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x05, 0x03, 0x15, 0x00,
                                  0x99 };

static void test_link_stats(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(LINK, sizeof LINK, &m), CRSF_MSG_LINK_STATS);
    CHECK_EQ_INT(m.u.link.up_rssi1, -67);
    CHECK_EQ_INT(m.u.link.up_rssi2, -70);
    CHECK_EQ_INT(m.u.link.up_lq, 100);
    CHECK_EQ_INT(m.u.link.up_snr, 9);
    CHECK_EQ_INT(m.u.link.antenna, 1);
    CHECK_EQ_INT(m.u.link.rf_mode, 7);
    CHECK_EQ_INT(m.u.link.tx_power_mw, 100);
    CHECK_EQ_INT(m.u.link.dn_rssi, -55);
    CHECK_EQ_INT(m.u.link.dn_lq, 98);
    CHECK_EQ_INT(m.u.link.dn_snr, -4);
}

static void test_battery(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(BATTERY, sizeof BATTERY, &m), CRSF_MSG_BATTERY);
    CHECK_EQ_INT(m.u.battery.voltage_dv, 168);
    CHECK_EQ_INT(m.u.battery.current_da, 45);
    CHECK_EQ_INT(m.u.battery.capacity_mah, 1234);
    CHECK_EQ_INT(m.u.battery.remaining_pct, 87);
}

static void test_flight_mode(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(FLIGHT_MODE, sizeof FLIGHT_MODE, &m), CRSF_MSG_FLIGHT_MODE);
    CHECK_STR(m.u.flight_mode.mode, "ACRO*");
}

static void test_timing(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(TIMING, sizeof TIMING, &m), CRSF_MSG_TIMING);
    CHECK_EQ_INT(m.u.timing.interval_0p1us, 40000);
    CHECK_EQ_INT(m.u.timing.offset_0p1us, -1234);
}

static void test_device_info(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(DEVICE, sizeof DEVICE, &m), CRSF_MSG_DEVICE_INFO);
    CHECK_STR(m.u.device.name, "BETAFPV 1W");
    CHECK_EQ_INT(m.u.device.origin, 0xEE);
    CHECK_EQ_INT(m.u.device.serial, 0x454C5253);
    CHECK_EQ_INT(m.u.device.sw_major, 3);
    CHECK_EQ_INT(m.u.device.sw_minor, 5);
    CHECK_EQ_INT(m.u.device.sw_patch, 3);
    CHECK_EQ_INT(m.u.device.field_count, 21);
}

static void test_long_device_name_is_truncated(void)
{
    uint8_t f[80] = { 0xEA, 0, 0x29, 0xEA, 0xEE };
    size_t n = 5;
    for (int i = 0; i < 40; i++)
        f[n++] = (uint8_t)('A' + i % 26);
    f[n++] = 0;
    static const uint8_t tail[] = { 'E', 'L', 'R', 'S', 0, 0, 0, 0, 0, 3, 5, 3, 21, 0 };
    memcpy(f + n, tail, sizeof tail);
    n += sizeof tail;
    f[n++] = 0;                                       /* CRC (not checked here) */
    f[1] = (uint8_t)(n - 2);
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(f, n, &m), CRSF_MSG_DEVICE_INFO);
    CHECK_EQ_INT(strlen(m.u.device.name), sizeof m.u.device.name - 1);
    CHECK_EQ_INT(m.u.device.sw_minor, 5);
    CHECK_EQ_INT(m.u.device.serial, 0x454C5253);
}

static void test_rc_channels_round_trip(void)
{
    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    crsf_msg_t m;
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = (uint16_t)(CRSF_CH_MIN + i);
    crsf_build_rc_frame(frame, ch);
    CHECK_EQ_INT(crsf_decode(frame, sizeof frame, &m), CRSF_MSG_RC_CHANNELS);
    CHECK_MEM(m.u.channels, ch, sizeof ch);
}

static void test_wrong_lengths_are_rejected(void)
{
    crsf_msg_t m;
    uint8_t shortened[sizeof LINK];
    memcpy(shortened, LINK, sizeof LINK);
    shortened[1] = 0x0B;                              /* claims one byte less than it has */
    CHECK_EQ_INT(crsf_decode(shortened, sizeof shortened, &m), CRSF_MSG_NONE);
    CHECK_EQ_INT(crsf_decode(LINK, 3, &m), CRSF_MSG_NONE);

    uint8_t no_nul[sizeof DEVICE];
    memcpy(no_nul, DEVICE, sizeof DEVICE);
    for (size_t i = 5; i < sizeof DEVICE - 1; i++)
        if (no_nul[i] == 0)
            no_nul[i] = 'x';                          /* name without terminator */
    CHECK_EQ_INT(crsf_decode(no_nul, sizeof no_nul, &m), CRSF_MSG_NONE);
}

static void test_flight_mode_is_truncated_safely(void)
{
    uint8_t frame[40] = { 0xEA, 0, 0x21 };
    size_t n = 3;
    for (int i = 0; i < 30; i++)
        frame[n++] = 'A';
    frame[n++] = 0x00;     /* CRC is not checked by crsf_decode */
    frame[1] = (uint8_t)(n - 2);
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(frame, n, &m), CRSF_MSG_FLIGHT_MODE);
    CHECK_EQ_INT(strlen(m.u.flight_mode.mode), sizeof m.u.flight_mode.mode - 1);
}

int main(void)
{
    RUN(test_link_stats);
    RUN(test_battery);
    RUN(test_flight_mode);
    RUN(test_timing);
    RUN(test_device_info);
    RUN(test_long_device_name_is_truncated);
    RUN(test_rc_channels_round_trip);
    RUN(test_wrong_lengths_are_rejected);
    RUN(test_flight_mode_is_truncated_safely);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_telem.c:2:10: fatal error: crsf_telem.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/crsf_telem.h`:

```c
/* crsf_telem.h - decode the CRSF frames an ELRS TX module sends to the handset. */
#ifndef CRSF_TELEM_H
#define CRSF_TELEM_H

#include <stddef.h>
#include <stdint.h>
#include "crsf.h"

typedef struct {
    int8_t up_rssi1;        /* dBm, measured by the receiver (antenna 1) */
    int8_t up_rssi2;        /* dBm, antenna 2 */
    uint8_t up_lq;          /* uplink link quality, % */
    int8_t up_snr;          /* dB */
    uint8_t antenna;
    uint8_t rf_mode;        /* ELRS packet-rate index */
    uint16_t tx_power_mw;
    int8_t dn_rssi;         /* dBm, measured by the TX module */
    uint8_t dn_lq;          /* downlink link quality, % */
    int8_t dn_snr;          /* dB */
} crsf_link_stats_t;

typedef struct {
    uint16_t voltage_dv;    /* 0.1 V */
    uint16_t current_da;    /* 0.1 A */
    uint32_t capacity_mah;  /* used */
    uint8_t remaining_pct;
} crsf_battery_t;

typedef struct {
    char mode[16];          /* Betaflight: e.g. "ACRO", "!FS!"; '*' suffix means disarmed */
} crsf_flight_mode_t;

typedef struct {
    uint32_t interval_0p1us; /* frame interval the module wants, in 0.1 us */
    int32_t offset_0p1us;    /* phase correction: positive = send the next frame later */
} crsf_timing_t;

typedef struct {
    uint8_t origin;
    char name[32];
    uint32_t serial;        /* 0x454C5253 ("ELRS") for ExpressLRS devices */
    uint8_t sw_major, sw_minor, sw_patch;
    uint8_t field_count;
    uint8_t param_version;
} crsf_device_info_t;

typedef enum {
    CRSF_MSG_NONE = 0,
    CRSF_MSG_LINK_STATS,
    CRSF_MSG_BATTERY,
    CRSF_MSG_FLIGHT_MODE,
    CRSF_MSG_TIMING,
    CRSF_MSG_DEVICE_INFO,
    CRSF_MSG_RC_CHANNELS,
} crsf_msg_kind_t;

typedef struct {
    crsf_msg_kind_t kind;
    union {
        crsf_link_stats_t link;
        crsf_battery_t battery;
        crsf_flight_mode_t flight_mode;
        crsf_timing_t timing;
        crsf_device_info_t device;
        uint16_t channels[CRSF_NUM_CHANNELS];
    } u;
} crsf_msg_t;

/* Decode one complete frame (as delivered by the deframer, CRC already checked).
 * Returns the message kind; CRSF_MSG_NONE for unknown types or malformed lengths. */
crsf_msg_kind_t crsf_decode(const uint8_t *frame, size_t len, crsf_msg_t *out);

#endif
```

Create `core/src/crsf_telem.c`:

```c
#include "crsf_telem.h"
#include <string.h>

static const uint16_t TX_POWER_MW[] = { 0, 10, 25, 100, 500, 1000, 2000, 250, 50 };

static uint16_t be16(const uint8_t *p)
{
    return (uint16_t)((p[0] << 8) | p[1]);
}

static uint32_t be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static crsf_msg_kind_t decode_link_stats(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    if (plen != 10)
        return CRSF_MSG_NONE;
    crsf_link_stats_t *l = &m->u.link;
    l->up_rssi1 = (int8_t)p[0];
    l->up_rssi2 = (int8_t)p[1];
    l->up_lq = p[2];
    l->up_snr = (int8_t)p[3];
    l->antenna = p[4];
    l->rf_mode = p[5];
    l->tx_power_mw = p[6] < sizeof TX_POWER_MW / sizeof TX_POWER_MW[0] ? TX_POWER_MW[p[6]] : 0;
    l->dn_rssi = (int8_t)p[7];
    l->dn_lq = p[8];
    l->dn_snr = (int8_t)p[9];
    return CRSF_MSG_LINK_STATS;
}

static crsf_msg_kind_t decode_battery(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    if (plen != 8)
        return CRSF_MSG_NONE;
    m->u.battery.voltage_dv = be16(p);
    m->u.battery.current_da = be16(p + 2);
    m->u.battery.capacity_mah = ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 8) | p[6];
    m->u.battery.remaining_pct = p[7];
    return CRSF_MSG_BATTERY;
}

static crsf_msg_kind_t decode_flight_mode(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    if (plen < 1)
        return CRSF_MSG_NONE;
    size_t n = 0;
    while (n < plen && n < sizeof m->u.flight_mode.mode - 1 && p[n] != '\0') {
        m->u.flight_mode.mode[n] = (char)p[n];
        n++;
    }
    m->u.flight_mode.mode[n] = '\0';
    return CRSF_MSG_FLIGHT_MODE;
}

static crsf_msg_kind_t decode_radio_id(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    /* p[0] destination, p[1] origin, p[2] sub-type, then two big-endian 32-bit values */
    if (plen != 11 || p[2] != CRSF_RADIO_ID_TIMING)
        return CRSF_MSG_NONE;
    m->u.timing.interval_0p1us = be32(p + 3);
    m->u.timing.offset_0p1us = (int32_t)be32(p + 7);
    return CRSF_MSG_TIMING;
}

static crsf_msg_kind_t decode_device_info(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    /* p[0] destination, p[1] origin, NUL-terminated name, then 14 bytes of fixed fields */
    if (plen < 2 + 1 + 14)
        return CRSF_MSG_NONE;
    const uint8_t *name = p + 2;
    const uint8_t *nul = memchr(name, '\0', plen - 2);
    if (nul == NULL)
        return CRSF_MSG_NONE;
    size_t name_len = (size_t)(nul - name);
    if (2 + name_len + 1 + 14 > plen)
        return CRSF_MSG_NONE;

    crsf_device_info_t *d = &m->u.device;
    size_t copy = name_len < sizeof d->name - 1 ? name_len : sizeof d->name - 1;
    memcpy(d->name, name, copy);
    d->name[copy] = '\0';
    const uint8_t *q = nul + 1;
    d->origin = p[1];
    d->serial = be32(q);
    /* q[4..7] hardware version, q[8..11] software version (q[8] unused) */
    d->sw_major = q[9];
    d->sw_minor = q[10];
    d->sw_patch = q[11];
    d->field_count = q[12];
    d->param_version = q[13];
    return CRSF_MSG_DEVICE_INFO;
}

crsf_msg_kind_t crsf_decode(const uint8_t *frame, size_t len, crsf_msg_t *out)
{
    memset(out, 0, sizeof *out);
    if (len < 4 || (size_t)frame[1] + 2 != len)
        return CRSF_MSG_NONE;
    const uint8_t *p = frame + 3;   /* payload: after address, length and type */
    size_t plen = len - 4;          /* minus address, length, type and CRC */

    crsf_msg_kind_t kind;
    switch (frame[2]) {
    case CRSF_TYPE_LINK_STATS:  kind = decode_link_stats(p, plen, out); break;
    case CRSF_TYPE_BATTERY:     kind = decode_battery(p, plen, out); break;
    case CRSF_TYPE_FLIGHT_MODE: kind = decode_flight_mode(p, plen, out); break;
    case CRSF_TYPE_RADIO_ID:    kind = decode_radio_id(p, plen, out); break;
    case CRSF_TYPE_DEVICE_INFO: kind = decode_device_info(p, plen, out); break;
    case CRSF_TYPE_RC_CHANNELS:
        if (plen != 22)
            return CRSF_MSG_NONE;
        crsf_unpack_channels(p, out->u.channels);
        kind = CRSF_MSG_RC_CHANNELS;
        break;
    default:
        kind = CRSF_MSG_NONE;
        break;
    }
    out->kind = kind;
    return kind;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/crsf_telem.c core/src/crsf_telem.h core/tests/test_telem.c
git commit -m "core: decode ELRS telemetry, timing and device info"
```

### Task 5: Serial port

The test uses a pseudo-terminal pair, so it needs no hardware.

**Files:**
- Create: `core/src/serial.h`
- Create: `core/src/serial.c`
- Test: `core/tests/test_serial.c`

**Interfaces:**
- Consumes: nothing
- Produces: `int serial_open(const char *path, int baud)`: fd or -1 with errno; raw, non-blocking, exclusive. An empty read returns 0 (VMIN=0/VTIME=0), so callers detect an unplugged device from write() errors.

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_serial.c`:

```c
#define _GNU_SOURCE
#include "check.h"
#include "serial.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

/* Uses a pseudo-terminal pair so the test runs without hardware. */
static int open_pty(char *name, size_t cap)
{
    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0 || grantpt(master) < 0 || unlockpt(master) < 0)
        return -1;
    if (ptsname_r(master, name, cap) != 0)
        return -1;
    return master;
}

static void test_open_configures_raw_port(void)
{
    char name[64];
    int master = open_pty(name, sizeof name);
    CHECK(master >= 0);
    int fd = serial_open(name, 921600);
    CHECK(fd >= 0);

    static const uint8_t frame[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
    CHECK_EQ_INT(write(fd, frame, sizeof frame), sizeof frame);
    uint8_t got[16];
    usleep(20000);
    CHECK_EQ_INT(read(master, got, sizeof got), sizeof frame); /* raw: no byte translation */
    CHECK_MEM(got, frame, sizeof frame);

    /* With VMIN=0/VTIME=0 an empty tty read returns 0 at once (never blocks). A real
     * USB serial port behaves the same, so unplugging is detected by write() errors. */
    uint8_t buf[4];
    errno = 0;
    ssize_t r = read(fd, buf, sizeof buf);
    CHECK(r == 0 || (r == -1 && errno == EAGAIN));
    close(fd);
    close(master);
}

static void test_second_open_is_refused(void)
{
    char name[64];
    int master = open_pty(name, sizeof name);
    int fd = serial_open(name, 921600);
    CHECK(fd >= 0);
    CHECK_EQ_INT(serial_open(name, 921600), -1);     /* TIOCEXCL: e.g. crsf-param while crsf-core runs */
    CHECK_EQ_INT(errno, EBUSY);
    close(fd);
    close(master);
}

static void test_missing_device_fails(void)
{
    CHECK_EQ_INT(serial_open("/dev/does-not-exist", 921600), -1);
    CHECK_EQ_INT(errno, ENOENT);
}

int main(void)
{
    RUN(test_open_configures_raw_port);
    RUN(test_second_open_is_refused);
    RUN(test_missing_device_fails);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_serial.c:3:10: fatal error: serial.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/serial.h`:

```c
/* serial.h - open a serial port in raw 8N1 mode at any baud rate (Linux termios2). */
#ifndef SERIAL_H
#define SERIAL_H

/* Opens `path` non-blocking, raw, 8N1, no flow control, at `baud` (any value the
 * driver accepts, e.g. 921600), and takes an exclusive lock (TIOCEXCL) so a second
 * program cannot open the same port. Returns the fd, or -1 with errno set. */
int serial_open(const char *path, int baud);

#endif
```

Create `core/src/serial.c`:

```c
#include "serial.h"

#include <asm/termbits.h>   /* struct termios2 and BOTHER; do not mix with <termios.h> */
#include <errno.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>

int serial_open(const char *path, int baud)
{
    int fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0)
        return -1;

    struct termios2 tio;
    if (ioctl(fd, TIOCEXCL) < 0 || ioctl(fd, TCGETS2, &tio) < 0)
        goto fail;
    tio.c_cflag = CS8 | CREAD | CLOCAL | BOTHER;
    tio.c_iflag = 0;
    tio.c_oflag = 0;
    tio.c_lflag = 0;
    tio.c_cc[VMIN] = 0;
    tio.c_cc[VTIME] = 0;
    tio.c_ispeed = (speed_t)baud;
    tio.c_ospeed = (speed_t)baud;
    if (ioctl(fd, TCSETS2, &tio) < 0 || ioctl(fd, TCFLSH, TCIOFLUSH) < 0)
        goto fail;
    return fd;

fail:;
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/serial.c core/src/serial.h core/tests/test_serial.c
git commit -m "core: raw exclusive serial port at any baud"
```

### Task 6: ELRS parameter protocol

**Files:**
- Create: `core/src/crsf_param.h`
- Create: `core/src/crsf_param.c`
- Test: `core/tests/test_param.c`

**Interfaces:**
- Consumes: `crc8_d5`, CRSF constants
- Produces: `crsf_build_param_read`, `crsf_build_param_write`, `param_reader_t` with `param_reader_start` / `param_reader_feed` (1 complete, 0 next chunk, -1 not the expected chunk), `int param_parse(const param_reader_t *, crsf_param_t *)`, `param_option_index(p, prefix)`, `param_option(p, i, buf, cap)`; `PARAM_*` types

- [ ] **Step 1: Write the failing test**

Create `core/tests/test_param.c`:

```c
#include "check.h"
#include "crc8.h"
#include "crsf_param.h"

/* Builds a PARAMETER_ENTRY frame the way an ELRS module sends it. */
static size_t entry(uint8_t *out, uint8_t field, uint8_t remaining, const uint8_t *data, size_t n)
{
    out[0] = 0xEA;
    out[1] = (uint8_t)(n + 6);   /* type, dest, origin, field, remaining, data..., crc */
    out[2] = CRSF_TYPE_PARAM_ENTRY;
    out[3] = CRSF_ADDR_LUA;
    out[4] = 0xEE;
    out[5] = field;
    out[6] = remaining;
    memcpy(out + 7, data, n);
    out[7 + n] = crc8_d5(out + 2, n + 5);
    return n + 8;
}

/* One field in one chunk. */
static int read_one(param_reader_t *r, uint8_t field, const uint8_t *data, size_t n)
{
    uint8_t f[128];
    param_reader_start(r, field);
    return param_reader_feed(r, f, entry(f, field, 0, data, n));
}

/* parent 0, type 9, "Packet Rate", options with a hidden (empty) one, value 2,
 * min 0, max 3, default 2, unit "" */
static const uint8_t PACKET_RATE[] = "\x00\x09Packet Rate\0" "50Hz;;250Hz;500Hz\0" "\x02\x00\x03\x02" "";

static void test_read_and_write_frames(void)
{
    static const uint8_t read_golden[] = { 0xEE, 0x06, 0x2C, 0xEE, 0xEF, 0x01, 0x00, 0x76 };
    static const uint8_t write_golden[] = { 0xEE, 0x06, 0x2D, 0xEE, 0xEF, 0x05, 0x03, 0x46 };
    uint8_t buf[16];
    CHECK_EQ_INT(crsf_build_param_read(buf, sizeof buf, 0xEE, 1, 0), sizeof read_golden);
    CHECK_MEM(buf, read_golden, sizeof read_golden);
    CHECK_EQ_INT(crsf_build_param_write(buf, sizeof buf, 0xEE, 5, 3), sizeof write_golden);
    CHECK_MEM(buf, write_golden, sizeof write_golden);
    CHECK_EQ_INT(crsf_build_param_read(buf, 7, 0xEE, 1, 0), 0);
}

static void test_text_selection_in_two_chunks(void)
{
    uint8_t f1[64], f2[64];
    size_t first = 14;
    size_t n1 = entry(f1, 4, 1, PACKET_RATE, first);
    size_t n2 = entry(f2, 4, 0, PACKET_RATE + first, sizeof PACKET_RATE - first);

    param_reader_t r;
    param_reader_start(&r, 4);
    CHECK_EQ_INT(param_reader_feed(&r, f1, n1), 0);
    CHECK_EQ_INT(r.next_chunk, 1);
    CHECK_EQ_INT(param_reader_feed(&r, f2, n2), 1);

    crsf_param_t p;
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_EQ_INT(p.id, 4);
    CHECK_EQ_INT(p.type, PARAM_TEXT_SELECTION);
    CHECK(!p.hidden);
    CHECK_STR(p.name, "Packet Rate");
    CHECK_STR(p.options, "50Hz;;250Hz;500Hz");
    CHECK_EQ_INT(p.value, 2);
    CHECK_STR(p.text, "");
}

static void test_repeated_chunk_is_rejected(void)
{
    /* ELRS answers a retried request again: chunk 0 twice must not corrupt the field. */
    uint8_t f1[64], f2[64];
    size_t first = 14;
    size_t n1 = entry(f1, 4, 1, PACKET_RATE, first);
    size_t n2 = entry(f2, 4, 0, PACKET_RATE + first, sizeof PACKET_RATE - first);
    param_reader_t r;
    param_reader_start(&r, 4);
    CHECK_EQ_INT(param_reader_feed(&r, f1, n1), 0);
    CHECK_EQ_INT(param_reader_feed(&r, f1, n1), -1);     /* duplicate of chunk 0 */
    CHECK_EQ_INT(param_reader_feed(&r, f2, n2), 1);
    crsf_param_t p;
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_STR(p.options, "50Hz;;250Hz;500Hz");
}

static void test_option_lookup(void)
{
    param_reader_t r;
    crsf_param_t p;
    CHECK_EQ_INT(read_one(&r, 4, PACKET_RATE, sizeof PACKET_RATE), 1);
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    char buf[32];
    CHECK_STR(param_option(&p, 2, buf, sizeof buf), "250Hz");
    CHECK_STR(param_option(&p, 1, buf, sizeof buf), "");        /* hidden option */
    CHECK_STR(param_option(&p, 9, buf, sizeof buf), "");
    CHECK_EQ_INT(param_option_index(&p, "250"), 2);
    CHECK_EQ_INT(param_option_index(&p, "500hz"), 3);
    CHECK_EQ_INT(param_option_index(&p, "1000"), -1);
    CHECK_EQ_INT(param_option_index(&p, ""), 0);
}

static void test_info_and_hidden_folder(void)
{
    static const uint8_t info[] = "\x00\x0C" "Bad/Good\0" "0/250";
    static const uint8_t folder[] = "\x00\x8B" "TX Power\0" "\x04\x05\xFF";
    param_reader_t r;
    crsf_param_t p;
    CHECK_EQ_INT(read_one(&r, 6, info, sizeof info), 1);
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_EQ_INT(p.type, PARAM_INFO);
    CHECK_STR(p.text, "0/250");

    CHECK_EQ_INT(read_one(&r, 3, folder, sizeof folder - 1), 1);
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_EQ_INT(p.type, PARAM_FOLDER);
    CHECK(p.hidden);
    CHECK_STR(p.name, "TX Power");
}

static void test_wrong_frames_are_rejected(void)
{
    uint8_t f[64];
    param_reader_t r;
    param_reader_start(&r, 4);
    CHECK_EQ_INT(param_reader_feed(&r, f, entry(f, 5, 0, PACKET_RATE, 10)), -1);  /* other field */
    static const uint8_t ping[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
    CHECK_EQ_INT(param_reader_feed(&r, ping, sizeof ping), -1);
}

static void test_malformed_data(void)
{
    static const uint8_t no_nul[] = { 0x00, 0x09, 'A', 'B' };
    static const uint8_t short_sel[] = "\x00\x09Rate\0" "a;b";          /* options never end */
    param_reader_t r;
    crsf_param_t p;
    CHECK_EQ_INT(read_one(&r, 1, no_nul, sizeof no_nul), 1);
    CHECK_EQ_INT(param_parse(&r, &p), -1);
    CHECK_EQ_INT(read_one(&r, 1, short_sel, sizeof short_sel - 1), 1);
    CHECK_EQ_INT(param_parse(&r, &p), -1);
}

int main(void)
{
    RUN(test_read_and_write_frames);
    RUN(test_text_selection_in_two_chunks);
    RUN(test_repeated_chunk_is_rejected);
    RUN(test_option_lookup);
    RUN(test_info_and_hidden_folder);
    RUN(test_wrong_frames_are_rejected);
    RUN(test_malformed_data);
    return CHECK_EXIT();
}
```

- [ ] **Step 2: Run the tests to see this one fail**

Run: `make -C core test`

Expected: FAIL: the build stops with `tests/test_param.c:3:10: fatal error: crsf_param.h: No such file or directory`

- [ ] **Step 3: Write the implementation**

Create `core/src/crsf_param.h`:

```c
/* crsf_param.h - the ELRS "Lua" parameter protocol: read a device's settings (packet
 * rate, telemetry ratio, TX power, ...) and change text-selection settings.
 *
 * Read:  PARAMETER_READ  (0x2C) dest, origin, field id, chunk
 * Reply: PARAMETER_ENTRY (0x2B) dest, origin, field id, chunks remaining, data...
 *        Chunk 0 data starts with parent id and type; the chunks concatenated form
 *        "name\0" followed by type-specific fields.
 * Write: PARAMETER_WRITE (0x2D) dest, origin, field id, value */
#ifndef CRSF_PARAM_H
#define CRSF_PARAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CRSF_TYPE_PARAM_ENTRY 0x2B
#define CRSF_TYPE_PARAM_READ  0x2C
#define CRSF_TYPE_PARAM_WRITE 0x2D
#define CRSF_ADDR_LUA         0xEF  /* origin used by the ELRS Lua script */

typedef enum {
    PARAM_UINT8 = 0,
    PARAM_INT8 = 1,
    PARAM_TEXT_SELECTION = 9,
    PARAM_STRING = 10,
    PARAM_FOLDER = 11,
    PARAM_INFO = 12,
    PARAM_COMMAND = 13,
} param_type_t;

typedef struct {
    uint8_t id;
    uint8_t parent;
    uint8_t type;          /* param_type_t (hidden bit removed) */
    bool hidden;
    char name[48];
    char options[512];     /* text selection: ';'-separated, may contain empty (hidden) options */
    uint8_t value;         /* text selection index / uint8 value */
    char text[64];         /* info and string value, or text-selection unit */
} crsf_param_t;

typedef struct {
    uint8_t field_id;
    uint8_t parent;
    uint8_t type;
    uint8_t data[1024];
    size_t len;
    int next_chunk;        /* chunk index to request next */
    int remaining;         /* "chunks remaining" of the last accepted chunk */
} param_reader_t;

size_t crsf_build_param_read(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t chunk);
size_t crsf_build_param_write(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t value);

void param_reader_start(param_reader_t *r, uint8_t field_id);
/* Feed one complete frame. Returns 1 when the field is complete, 0 if the next chunk
 * (r->next_chunk) must be requested, -1 if the frame is not the expected chunk (other
 * field, or a repeated/skipped chunk, which ELRS sends when a request is retried). */
int param_reader_feed(param_reader_t *r, const uint8_t *frame, size_t len);
/* Decode a completed reader. Returns 0, or -1 if the data is malformed. */
int param_parse(const param_reader_t *r, crsf_param_t *out);

/* Index of the first non-empty option starting with `prefix` (case-insensitive), or -1. */
int param_option_index(const crsf_param_t *p, const char *prefix);
/* Copies option `index` into buf ("" if out of range). Returns buf. */
const char *param_option(const crsf_param_t *p, int index, char *buf, size_t cap);

#endif
```

Create `core/src/crsf_param.c`:

```c
#include "crsf_param.h"

#include <string.h>
#include <strings.h>

#include "crc8.h"
#include "crsf.h"

static size_t build4(uint8_t *out, size_t cap, uint8_t type, uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
    if (cap < 8)
        return 0;
    out[0] = CRSF_ADDR_MODULE;
    out[1] = 6;
    out[2] = type;
    out[3] = a;
    out[4] = b;
    out[5] = c;
    out[6] = d;
    out[7] = crc8_d5(out + 2, 5);
    return 8;
}

size_t crsf_build_param_read(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t chunk)
{
    return build4(out, cap, CRSF_TYPE_PARAM_READ, device, CRSF_ADDR_LUA, field, chunk);
}

size_t crsf_build_param_write(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t value)
{
    return build4(out, cap, CRSF_TYPE_PARAM_WRITE, device, CRSF_ADDR_LUA, field, value);
}

void param_reader_start(param_reader_t *r, uint8_t field_id)
{
    memset(r, 0, sizeof *r);
    r->field_id = field_id;
}

int param_reader_feed(param_reader_t *r, const uint8_t *f, size_t len)
{
    /* addr, len, type, dest, origin, field id, chunks remaining, data..., crc */
    if (len < 8 || f[2] != CRSF_TYPE_PARAM_ENTRY || f[5] != r->field_id)
        return -1;
    const uint8_t *data = f + 7;
    size_t n = len - 8;
    if (r->next_chunk > 0 && f[6] != r->remaining - 1)
        return -1;
    if (r->next_chunk == 0) {
        if (n < 2)
            return -1;
        r->parent = data[0];
        r->type = data[1];
        data += 2;
        n -= 2;
    }
    if (r->len + n > sizeof r->data)
        return -1;
    memcpy(r->data + r->len, data, n);
    r->len += n;
    r->remaining = f[6];
    if (f[6] == 0)
        return 1;
    r->next_chunk++;
    return 0;
}

/* Copies a NUL-terminated string starting at *pos; advances *pos past the NUL. */
static int take_str(const param_reader_t *r, size_t *pos, char *out, size_t cap)
{
    const uint8_t *start = r->data + *pos;
    const uint8_t *nul = memchr(start, '\0', r->len - *pos);
    if (nul == NULL)
        return -1;
    size_t n = (size_t)(nul - start);
    size_t copy = n < cap - 1 ? n : cap - 1;
    memcpy(out, start, copy);
    out[copy] = '\0';
    *pos += n + 1;
    return 0;
}

int param_parse(const param_reader_t *r, crsf_param_t *p)
{
    memset(p, 0, sizeof *p);
    p->id = r->field_id;
    p->parent = r->parent;
    p->type = r->type & 0x7F;
    p->hidden = (r->type & 0x80) != 0;
    size_t pos = 0;
    if (take_str(r, &pos, p->name, sizeof p->name) != 0)
        return -1;

    switch (p->type) {
    case PARAM_TEXT_SELECTION:
        /* options\0 value min max default unit\0 */
        if (take_str(r, &pos, p->options, sizeof p->options) != 0 || pos + 4 > r->len)
            return -1;
        p->value = r->data[pos];
        pos += 4;
        if (take_str(r, &pos, p->text, sizeof p->text) != 0)
            p->text[0] = '\0';
        return 0;
    case PARAM_INFO:
    case PARAM_STRING:
        return take_str(r, &pos, p->text, sizeof p->text);
    case PARAM_UINT8:
    case PARAM_INT8:
        if (pos >= r->len)
            return -1;
        p->value = r->data[pos];
        return 0;
    default:
        return 0;   /* folders and commands: the name is all we show */
    }
}

const char *param_option(const crsf_param_t *p, int index, char *buf, size_t cap)
{
    const char *s = p->options;
    buf[0] = '\0';
    if (index < 0)
        return buf;
    for (int i = 0; i < index; i++) {
        s = strchr(s, ';');
        if (s == NULL)
            return buf;
        s++;
    }
    size_t n = strcspn(s, ";");
    if (n >= cap)
        n = cap - 1;
    memcpy(buf, s, n);
    buf[n] = '\0';
    return buf;
}

int param_option_index(const crsf_param_t *p, const char *prefix)
{
    size_t plen = strlen(prefix);
    const char *s = p->options;
    for (int i = 0;; i++) {
        size_t n = strcspn(s, ";");
        if (n > 0 && n >= plen && strncasecmp(s, prefix, plen) == 0)
            return i;
        if (s[n] == '\0')
            return -1;
        s += n + 1;
    }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `make -C core test`

Expected: PASS: every line starts with `PASS` and the output ends with `ALL TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/src/crsf_param.c core/src/crsf_param.h core/tests/test_param.c
git commit -m "core: ELRS parameter protocol (chunked reads, writes)"
```

### Task 7: Fake TX module and crsf-probe

`FakeTx` answers pings, records every RC frame, sends timing frames while RC frames arrive, optionally sends link/battery/flight-mode telemetry, and serves a small parameter menu (used by Task 8).

**Files:**
- Create: `core/tools/crsf-probe.c`
- Test: `core/tests/integration/fake_tx.py`
- Test: `core/tests/integration/test_probe.py`

**Interfaces:**
- Consumes: `serial_open`, `crsf_build_ping`, `crsf_build_model_select`, `crsf_build_rc_frame`, deframer, `crsf_decode`
- Produces: `build/crsf-probe [-b baud] [-t seconds] [--rc] <device>` (exit 0 = a device answered, 1 = none, 2 = usage/I/O); Python `FakeTx(interval_us, offset_us, name)` with `.path`, `.rc`, `.frames_since(t)`, `.last_channels()`, `.wait_for(pred)`, settable `.flight_mode`, `.link_lq`, `.battery_dv`, `.params`, `.param(name)`, `.close()`

- [ ] **Step 1: Write the fake module and the failing integration test**

Create `core/tests/integration/fake_tx.py`:

```python
"""Pretend to be an ELRS TX module on a pseudo-terminal (test double for crsf-core).

Written independently of the C code so the two implementations check each other.
"""
import os
import select
import threading
import time
import tty


def crc8_d5(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0xD5) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def frame(addr, body):
    """addr, len, body..., crc  where body starts with the type byte."""
    return bytes([addr, len(body) + 1]) + bytes(body) + bytes([crc8_d5(body)])


def unpack_channels(payload):
    bits, nbits, out, i = 0, 0, [], 0
    for _ in range(16):
        while nbits < 11:
            bits |= payload[i] << nbits
            nbits += 8
            i += 1
        out.append(bits & 0x7FF)
        bits >>= 11
        nbits -= 11
    return out


# Settings the fake module exposes through the parameter protocol (like the ELRS Lua menu).
# (id, parent, type, name, payload-after-name). Types: 9 text selection, 11 folder, 12 info.
def _sel(options, value, unit=""):
    return options.encode() + b"\0" + bytes([value, 0, len(options.split(";")) - 1, value]) + unit.encode() + b"\0"


DEFAULT_PARAMS = [
    [1, 0, 9, "Packet Rate", "50Hz(-115dbm);;150Hz(-112dbm);250Hz(-108dbm);500Hz(-105dbm)", 3, ""],
    [2, 0, 9, "Telem Ratio", "Std;Off;1:128;1:64;1:32", 0, ""],
    [3, 0, 11, "TX Power", None, None, None],
    [4, 3, 9, "Max Power", "10;25;50;100;250;500;1000", 3, "mW"],
    [5, 3, 9, "Dynamic", "Off;Dyn;AUX9", 0, ""],
    [6, 0, 12, "Bad/Good", "0/250", None, None],
]
CHUNK = 24   # bytes of field data per PARAMETER_ENTRY frame (forces multi-chunk reads)


class FakeTx:
    """ELRS TX stand-in.

    * answers device pings with DEVICE_INFO
    * records every RC_CHANNELS frame as (monotonic_time, [16 channel values])
    * once RC frames arrive, sends timing frames every 200 ms (interval/offset settable)
    * optionally sends link stats, battery and flight mode telemetry
    """

    def __init__(self, interval_us=4000.0, offset_us=0.0, name="FAKE TX"):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        self.path = os.ttyname(self.slave)
        self.name = name
        self.interval_us = interval_us
        self.offset_us = offset_us
        self.flight_mode = None
        self.link_lq = None
        self.battery_dv = None
        self.rc = []
        self.model_selects = 0
        self.pings = 0
        self.params = [list(p) for p in DEFAULT_PARAMS]
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._buf = bytearray()
        self._closed = False
        self._threads = [threading.Thread(target=self._reader, daemon=True),
                         threading.Thread(target=self._talker, daemon=True)]
        for t in self._threads:
            t.start()

    # --- helpers for tests -------------------------------------------------
    def frames_since(self, t0):
        with self._lock:
            return [f for f in self.rc if f[0] >= t0]

    def last_channels(self):
        with self._lock:
            return self.rc[-1][1] if self.rc else None

    def wait_for(self, predicate, timeout=2.0):
        """Poll until predicate(last_channels) is true; returns the time it became true."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            ch = self.last_channels()
            if ch is not None and predicate(ch):
                return time.monotonic()
            time.sleep(0.002)
        return None

    def close(self):
        if self._closed:          # tests may unplug the module and then clean up
            return
        self._closed = True
        self._stop.set()
        for t in self._threads:
            t.join(timeout=1)
        os.close(self.master)
        os.close(self.slave)

    # --- internals -----------------------------------------------------------
    def _send(self, data):
        try:
            os.write(self.master, data)
        except OSError:
            pass

    def _device_info(self):
        body = [0x29, 0xEA, 0xEE] + list(self.name.encode()) + [0]
        body += list(b"ELRS") + [0, 0, 0, 0] + [0, 3, 5, 3] + [len(self.params), 0]
        return frame(0xEA, body)

    def param(self, name):
        return next(p for p in self.params if p[3] == name)

    def _param_data(self, p):
        pid, parent, ptype, name, a, b, c = p
        data = bytes([parent, ptype]) + name.encode() + b"\0"
        if ptype == 9:
            data += _sel(a, b, c)
        elif ptype == 11:
            data += bytes([q[0] for q in self.params if q[1] == pid] + [0xFF])
        elif ptype == 12:
            data += a.encode() + b"\0"
        return data

    def _param_entry(self, field, chunk):
        p = next((q for q in self.params if q[0] == field), None)
        if p is None:
            return
        data = self._param_data(p)
        chunks = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)]
        if chunk >= len(chunks):
            return
        body = [0x2B, 0xEF, 0xEE, field, len(chunks) - 1 - chunk] + list(chunks[chunk])
        self._send(frame(0xEA, body))

    def _handle(self, f):
        ftype = f[2]
        if ftype == 0x16 and len(f) == 26:
            with self._lock:
                self.rc.append((time.monotonic(), unpack_channels(f[3:25])))
        elif ftype == 0x28:
            self.pings += 1
            self._send(self._device_info())
        elif ftype == 0x32 and len(f) >= 8 and f[5] == 0x10 and f[6] == 0x05:
            self.model_selects += 1
        elif ftype == 0x2C and len(f) == 8:
            self._param_entry(f[5], f[6])
        elif ftype == 0x2D and len(f) == 8:
            p = next((q for q in self.params if q[0] == f[5]), None)
            if p is not None and p[2] == 9:
                p[5] = f[6]

    def _reader(self):
        while not self._stop.is_set():
            r, _, _ = select.select([self.master], [], [], 0.05)
            if not r:
                continue
            try:
                self._buf += os.read(self.master, 512)
            except OSError:
                return
            while len(self._buf) >= 2:
                if self._buf[0] not in (0xEE, 0xC8, 0xEA):
                    del self._buf[0]
                    continue
                total = self._buf[1] + 2
                if self._buf[1] < 2 or total > 64:
                    del self._buf[0]
                    continue
                if len(self._buf) < total:
                    break
                f = bytes(self._buf[:total])
                if crc8_d5(f[2:-1]) == f[-1]:
                    self._handle(f)
                    del self._buf[:total]
                else:
                    del self._buf[0]

    def _talker(self):
        next_sync = next_tel = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            with self._lock:
                streaming = bool(self.rc) and now - self.rc[-1][0] < 0.5
            if streaming and now >= next_sync:
                rate = int(self.interval_us * 10)
                off = int(self.offset_us * 10) & 0xFFFFFFFF
                body = [0x3A, 0xEA, 0xEE, 0x10] + list(rate.to_bytes(4, "big")) + list(off.to_bytes(4, "big"))
                self._send(frame(0xEA, body))
                next_sync = now + 0.2
            if now >= next_tel:
                if self.link_lq is not None:
                    self._send(frame(0xEA, [0x14, 0xBD, 0xBA, self.link_lq, 9, 1, 7, 3, 0xC9, 98, 0xFC]))
                if self.battery_dv is not None:
                    v = self.battery_dv
                    self._send(frame(0xEA, [0x08, v >> 8, v & 0xFF, 0, 45, 0, 4, 0xD2, 87]))
                if self.flight_mode is not None:
                    self._send(frame(0xEA, [0x21] + list(self.flight_mode.encode()) + [0]))
                next_tel = now + 0.1
            time.sleep(0.005)
```

Create `core/tests/integration/test_probe.py`:

```python
import os
import subprocess
import time
import unittest

from fake_tx import FakeTx

CORE = os.path.join(os.path.dirname(__file__), "..", "..")
PROBE = os.path.join(CORE, "build", "crsf-probe")


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.tx = FakeTx()

    def tearDown(self):
        self.tx.close()

    def test_reports_device_and_exits_zero(self):
        out = subprocess.run([PROBE, "-t", "1", self.tx.path], capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('device 0xEE: "FAKE TX" ExpressLRS 3.5.3', out.stdout)

    def test_rc_mode_streams_disarmed_frames_at_module_rate(self):
        self.tx.interval_us = 5000.0                      # module asks for 200 Hz
        t0 = time.monotonic()
        out = subprocess.run([PROBE, "-t", "2", "--rc", self.tx.path], capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("timing: interval 5000.0 us (200.0 Hz)", out.stdout)
        self.assertGreaterEqual(self.tx.model_selects, 1)
        frames = self.tx.frames_since(t0 + 1.0)           # after the first timing frames
        self.assertTrue(150 <= len(frames) <= 230, len(frames))
        ch = frames[-1][1]
        self.assertEqual(ch[2], 192)                      # throttle 1000 us
        self.assertEqual(ch[4], 192)                      # AUX1 (arm) low
        self.assertEqual(ch[0], 992)                      # roll centred

    def test_no_answer_exits_one(self):
        master, slave = os.openpty()
        try:
            out = subprocess.run([PROBE, "-t", "1", os.ttyname(slave)], capture_output=True, text=True, timeout=10)
            self.assertEqual(out.returncode, 1)
            self.assertIn("no CRSF device answered", out.stderr)
        finally:
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the integration tests to see them fail**

Run: `make -C core integration`

Expected: FAIL: three errors like `FileNotFoundError: [Errno 2] No such file or directory: '…/core/tests/integration/../../build/crsf-probe'`, then `FAILED (errors=3)`

- [ ] **Step 3: Write the tool**

Create `core/tools/crsf-probe.c`:

```c
/* crsf-probe - check that an ELRS TX module answers CRSF on a serial port.
 *
 *   crsf-probe [-b baud] [-t seconds] [--rc] <device>
 *
 * Sends a device ping every 100 ms and prints what comes back. With --rc it also
 * streams "safe" RC frames (sticks centred, throttle and every AUX low = disarmed),
 * which makes the module start its timing frames. Remove propellers before --rc.
 * Exit status: 0 = a device answered, 1 = nothing answered, 2 = usage or I/O error. */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "crsf.h"
#include "crsf_deframer.h"
#include "crsf_telem.h"
#include "serial.h"
#include "timeutil.h"

#define ELRS_SERIAL 0x454C5253u

typedef struct {
    bool got_device;
    uint8_t origins[8];
    int n_origins;
    int64_t period_ns;
    int64_t last_timing, last_link, last_battery;
    char mode[16];
} probe_t;

static bool once_per_second(int64_t *last, int64_t now)
{
    if (now - *last < NS_PER_S)
        return false;
    *last = now;
    return true;
}

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    probe_t *p = user;
    crsf_msg_t m;
    int64_t now = mono_ns();

    switch (crsf_decode(frame, len, &m)) {
    case CRSF_MSG_DEVICE_INFO:
        p->got_device = true;
        for (int i = 0; i < p->n_origins; i++)
            if (p->origins[i] == m.u.device.origin)
                return;
        if (p->n_origins < (int)sizeof p->origins)
            p->origins[p->n_origins++] = m.u.device.origin;
        printf("device 0x%02X: \"%s\" %s %u.%u.%u (%u parameters)\n", m.u.device.origin,
               m.u.device.name, m.u.device.serial == ELRS_SERIAL ? "ExpressLRS" : "firmware",
               m.u.device.sw_major, m.u.device.sw_minor, m.u.device.sw_patch,
               m.u.device.field_count);
        break;
    case CRSF_MSG_TIMING: {
        int64_t period = (int64_t)m.u.timing.interval_0p1us * 100;
        if (period >= 500 * NS_PER_US && period <= 50 * NS_PER_MS)
            p->period_ns = period;
        if (once_per_second(&p->last_timing, now))
            printf("timing: interval %.1f us (%.1f Hz), offset %+.1f us\n",
                   m.u.timing.interval_0p1us / 10.0, 1e7 / m.u.timing.interval_0p1us,
                   m.u.timing.offset_0p1us / 10.0);
        break;
    }
    case CRSF_MSG_LINK_STATS:
        if (once_per_second(&p->last_link, now))
            printf("link: uplink LQ %u%% RSSI %d/%d dBm, downlink LQ %u%% RSSI %d dBm, %u mW\n",
                   m.u.link.up_lq, m.u.link.up_rssi1, m.u.link.up_rssi2, m.u.link.dn_lq,
                   m.u.link.dn_rssi, m.u.link.tx_power_mw);
        break;
    case CRSF_MSG_BATTERY:
        if (once_per_second(&p->last_battery, now))
            printf("battery: %.1f V %.1f A %u mAh %u%%\n", m.u.battery.voltage_dv / 10.0,
                   m.u.battery.current_da / 10.0, m.u.battery.capacity_mah,
                   m.u.battery.remaining_pct);
        break;
    case CRSF_MSG_FLIGHT_MODE:
        if (strcmp(p->mode, m.u.flight_mode.mode) != 0) {
            snprintf(p->mode, sizeof p->mode, "%s", m.u.flight_mode.mode);
            printf("flight mode: %s\n", p->mode);
        }
        break;
    default:
        break;
    }
    fflush(stdout);
}

static int write_all(int fd, const uint8_t *buf, size_t len)
{
    ssize_t w = write(fd, buf, len);
    if (w < 0 && errno == EAGAIN)
        return 0;                       /* output buffer full: drop this frame */
    return w == (ssize_t)len ? 0 : -1;
}

static void usage(void)
{
    fprintf(stderr, "usage: crsf-probe [-b baud] [-t seconds] [--rc] <device>\n");
}

int main(int argc, char **argv)
{
    int baud = 921600;
    int seconds = 5;
    bool rc = false;
    static const struct option opts[] = {
        { "baud", required_argument, NULL, 'b' },
        { "time", required_argument, NULL, 't' },
        { "rc", no_argument, NULL, 'r' },
        { NULL, 0, NULL, 0 },
    };
    int c;
    while ((c = getopt_long(argc, argv, "b:t:", opts, NULL)) != -1) {
        switch (c) {
        case 'b': baud = atoi(optarg); break;
        case 't': seconds = atoi(optarg); break;
        case 'r': rc = true; break;
        default: usage(); return 2;
        }
    }
    if (optind != argc - 1 || baud <= 0 || seconds <= 0) {
        usage();
        return 2;
    }
    const char *dev = argv[optind];

    int fd = serial_open(dev, baud);
    if (fd < 0) {
        fprintf(stderr, "crsf-probe: %s: %s\n", dev, strerror(errno));
        return 2;
    }
    printf("probing %s at %d baud for %d s%s\n", dev, baud, seconds,
           rc ? " (sending disarmed RC frames)" : "");

    uint16_t ch[CRSF_NUM_CHANNELS];
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = crsf_us_to_ch(1000);    /* throttle and all AUX low: disarmed */
    ch[0] = ch[1] = ch[3] = CRSF_CH_MID; /* roll, pitch, yaw centred */
    uint8_t rc_frame[CRSF_RC_FRAME_LEN], ping[8], model[16];
    crsf_build_rc_frame(rc_frame, ch);
    size_t ping_len = crsf_build_ping(ping, sizeof ping);
    size_t model_len = crsf_build_model_select(model, sizeof model, 0);

    probe_t p = { .period_ns = 4 * NS_PER_MS };
    crsf_deframer_t d;
    crsf_deframer_init(&d);

    int64_t now = mono_ns();
    int64_t end = now + seconds * NS_PER_S;
    int64_t next_ping = now, next_rc = now;
    if (rc && write_all(fd, model, model_len) < 0)
        goto io_error;

    while ((now = mono_ns()) < end) {
        if (now >= next_ping) {
            if (write_all(fd, ping, ping_len) < 0)
                goto io_error;
            next_ping = now + 100 * NS_PER_MS;
        }
        if (rc && now >= next_rc) {
            if (write_all(fd, rc_frame, sizeof rc_frame) < 0)
                goto io_error;
            next_rc += p.period_ns;
            if (next_rc <= now)
                next_rc = now + p.period_ns;
        }
        int64_t wake = next_ping;
        if (rc && next_rc < wake)
            wake = next_rc;
        if (end < wake)
            wake = end;
        int timeout_ms = (int)((wake - now + NS_PER_MS - 1) / NS_PER_MS);
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        if (poll(&pfd, 1, timeout_ms) > 0) {
            if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL))
                goto io_error;
            uint8_t buf[256];
            ssize_t n = read(fd, buf, sizeof buf);
            if (n > 0)
                crsf_deframer_feed(&d, buf, (size_t)n, on_frame, &p);
        }
    }
    close(fd);
    printf("received %u valid frames, %u CRC errors\n", d.frames, d.crc_errors);
    if (!p.got_device) {
        fprintf(stderr, "crsf-probe: no CRSF device answered at %d baud\n", baud);
        return 1;
    }
    return 0;

io_error:
    fprintf(stderr, "crsf-probe: %s: I/O error: %s\n", dev, strerror(errno));
    close(fd);
    return 2;
}
```

- [ ] **Step 4: Run the integration tests to see them pass**

Run: `make -C core integration`

Expected: PASS: `Ran 3 tests` … `OK`

- [ ] **Step 5: Commit**

```bash
git add core/tests/integration/fake_tx.py core/tests/integration/test_probe.py core/tools/crsf-probe.c
git commit -m "core: crsf-probe and a Python fake TX module for integration tests"
```

### Task 8: crsf-param tool

**Files:**
- Create: `core/tools/crsf-param.c`
- Test: `core/tests/integration/test_param.py`

**Interfaces:**
- Consumes: the parameter protocol, `serial_open`, deframer, `crsf_decode`
- Produces: `build/crsf-param [-b baud] <device> list` and `… set "<setting>" <option prefix>` (exit 0 ok, 1 module/setting problem, 2 usage/I/O)

- [ ] **Step 1: Write the failing integration test**

Create `core/tests/integration/test_param.py`:

```python
import os
import subprocess
import unittest

from fake_tx import FakeTx

PARAM = os.path.join(os.path.dirname(__file__), "..", "..", "build", "crsf-param")


class ParamTest(unittest.TestCase):
    def setUp(self):
        self.tx = FakeTx()
        self.addCleanup(self.tx.close)

    def run_tool(self, *args):
        return subprocess.run([PARAM, self.tx.path, *args], capture_output=True, text=True, timeout=30)

    def test_list_shows_settings_with_values_and_folders(self):
        out = self.run_tool("list")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("FAKE TX, ExpressLRS 3.5.3, 6 settings", out.stdout)
        self.assertIn("[ 1] Packet Rate: 250Hz(-108dbm)", out.stdout)
        self.assertIn("[ 3] TX Power: (folder)", out.stdout)
        self.assertIn("  [ 4] Max Power: 100 mW", out.stdout)       # indented under the folder
        self.assertIn("[ 6] Bad/Good: 0/250", out.stdout)
        self.assertNotIn('""', out.stdout)                           # hidden options not shown

    def test_set_changes_value_and_confirms(self):
        out = self.run_tool("set", "packet rate", "500")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Packet Rate: 250Hz(-108dbm) -> 500Hz(-105dbm)", out.stdout)
        self.assertEqual(self.tx.param("Packet Rate")[5], 4)

    def test_set_unknown_option_fails_without_writing(self):
        out = self.run_tool("set", "Max Power", "2000")
        self.assertEqual(out.returncode, 1)
        self.assertIn("has no option starting with \"2000\"", out.stderr)
        self.assertEqual(self.tx.param("Max Power")[5], 3)

    def test_set_unknown_setting_fails(self):
        out = self.run_tool("set", "Warp Drive", "on")
        self.assertEqual(out.returncode, 1)
        self.assertIn("no selectable setting named", out.stderr)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the integration tests to see them fail**

Run: `make -C core integration`

Expected: FAIL: four errors `FileNotFoundError: … build/crsf-param`, then `FAILED (errors=4)`

- [ ] **Step 3: Write the tool**

Create `core/tools/crsf-param.c`:

```c
/* crsf-param - read and change ELRS TX module settings without a radio handset.
 *
 *   crsf-param [-b baud] <device> list
 *   crsf-param [-b baud] <device> set "<setting name>" <option prefix>
 *
 * Example: crsf-param /dev/ttyUSB0 set "Packet Rate" 250Hz
 * Stop crsf-core first: only one program can use the port. While it runs, the tool
 * streams disarmed RC frames (the module only answers a live "handset").
 * Exit status: 0 ok, 1 module/setting problem, 2 usage or I/O error. */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#include "crsf.h"
#include "crsf_deframer.h"
#include "crsf_param.h"
#include "crsf_telem.h"
#include "serial.h"
#include "timeutil.h"

#define MAX_FIELDS 64

typedef struct {
    int fd;
    crsf_deframer_t d;
    uint8_t rc[CRSF_RC_FRAME_LEN];
    int64_t next_rc;
    bool have_device;
    crsf_device_info_t device;
    param_reader_t reader;
    bool reading;
    int read_state;            /* 0 waiting, 1 complete, -2 next chunk needed */
    crsf_param_t fields[MAX_FIELDS + 1];
    bool loaded[MAX_FIELDS + 1];
} tool_t;

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    tool_t *t = user;
    if (frame[2] == CRSF_TYPE_PARAM_ENTRY && t->reading) {
        int r = param_reader_feed(&t->reader, frame, len);
        if (r == 1)
            t->read_state = 1;
        else if (r == 0)
            t->read_state = -2;
        return;
    }
    crsf_msg_t m;
    if (crsf_decode(frame, len, &m) == CRSF_MSG_DEVICE_INFO && m.u.device.origin == CRSF_ADDR_MODULE) {
        t->device = m.u.device;
        t->have_device = true;
    }
}

static int send_frame(tool_t *t, const uint8_t *buf, size_t n)
{
    ssize_t w = write(t->fd, buf, n);
    return (w == (ssize_t)n || (w < 0 && errno == EAGAIN)) ? 0 : -1;
}

/* Runs the port for `ms` milliseconds: keeps RC frames flowing and handles replies. */
static int pump(tool_t *t, int ms)
{
    int64_t end = mono_ns() + ms * NS_PER_MS;
    int64_t now;
    while ((now = mono_ns()) < end) {
        if (now >= t->next_rc) {
            if (send_frame(t, t->rc, sizeof t->rc) < 0)
                return -1;
            t->next_rc = now + 4 * NS_PER_MS;
        }
        int64_t wake = t->next_rc < end ? t->next_rc : end;
        struct pollfd p = { .fd = t->fd, .events = POLLIN };
        if (poll(&p, 1, (int)((wake - now + NS_PER_MS - 1) / NS_PER_MS)) > 0) {
            if (p.revents & (POLLERR | POLLHUP | POLLNVAL))
                return -1;
            uint8_t buf[256];
            ssize_t n = read(t->fd, buf, sizeof buf);
            if (n > 0)
                crsf_deframer_feed(&t->d, buf, (size_t)n, on_frame, t);
        }
        if (t->reading && t->read_state != 0)
            return 0;          /* let the caller react to a reply right away */
    }
    return 0;
}

static int find_module(tool_t *t)
{
    uint8_t buf[16];
    if (send_frame(t, buf, crsf_build_model_select(buf, sizeof buf, 0)) < 0)
        return -1;
    for (int i = 0; i < 25 && !t->have_device; i++) {
        if (send_frame(t, buf, crsf_build_ping(buf, sizeof buf)) < 0 || pump(t, 200) < 0)
            return -1;
    }
    return t->have_device ? 0 : 1;
}

/* Reads one field (all chunks). Returns 0 ok, 1 no answer, -1 I/O error. */
static int read_field(tool_t *t, uint8_t id)
{
    uint8_t buf[16];
    param_reader_start(&t->reader, id);
    t->reading = true;
    int tries = 0;
    while (tries < 5) {
        t->read_state = 0;
        if (send_frame(t, buf, crsf_build_param_read(buf, sizeof buf, CRSF_ADDR_MODULE, id,
                                                     (uint8_t)t->reader.next_chunk)) < 0 ||
            pump(t, 100) < 0) {
            t->reading = false;
            return -1;
        }
        if (t->read_state == 1)
            break;
        tries = t->read_state == -2 ? 0 : tries + 1;   /* progress resets the retry count */
    }
    t->reading = false;
    if (t->read_state != 1 || param_parse(&t->reader, &t->fields[id]) != 0)
        return 1;
    t->loaded[id] = true;
    return 0;
}

static void format_value(const crsf_param_t *p, char *out, size_t cap)
{
    char opt[64];
    switch (p->type) {
    case PARAM_TEXT_SELECTION:
        param_option(p, p->value, opt, sizeof opt);
        snprintf(out, cap, "%.40s%s%.40s", opt, p->text[0] ? " " : "", p->text);
        break;
    case PARAM_INFO:
    case PARAM_STRING:
        snprintf(out, cap, "%.80s", p->text);
        break;
    case PARAM_UINT8:
    case PARAM_INT8:
        snprintf(out, cap, "%d", p->type == PARAM_INT8 ? (int8_t)p->value : p->value);
        break;
    case PARAM_FOLDER:
        snprintf(out, cap, "(folder)");
        break;
    default:
        snprintf(out, cap, "(command)");
        break;
    }
}

static int depth(const tool_t *t, uint8_t id)
{
    int d = 0;
    for (uint8_t p = t->fields[id].parent; p != 0 && p <= MAX_FIELDS && d < 8; p = t->fields[p].parent)
        d++;
    return d;
}

static int load_all(tool_t *t)
{
    int count = t->device.field_count < MAX_FIELDS ? t->device.field_count : MAX_FIELDS;
    for (int id = 1; id <= count; id++) {
        int r = read_field(t, (uint8_t)id);
        if (r < 0)
            return -1;
        if (r > 0)
            fprintf(stderr, "crsf-param: field %d did not answer\n", id);
    }
    return 0;
}

static int cmd_list(tool_t *t)
{
    if (load_all(t) < 0)
        return 2;
    int count = t->device.field_count < MAX_FIELDS ? t->device.field_count : MAX_FIELDS;
    for (int id = 1; id <= count; id++) {
        const crsf_param_t *p = &t->fields[id];
        if (!t->loaded[id] || p->hidden)
            continue;
        char value[96];
        format_value(p, value, sizeof value);
        printf("%*s[%2d] %s: %s\n", 2 * depth(t, (uint8_t)id), "", id, p->name, value);
        if (p->type == PARAM_TEXT_SELECTION) {
            printf("%*s     options:", 2 * depth(t, (uint8_t)id), "");
            char opt[64];
            int n_opts = 1;
            for (const char *c = p->options; *c != '\0'; c++)
                n_opts += *c == ';';
            for (int i = 0; i < n_opts; i++)
                if (param_option(p, i, opt, sizeof opt)[0] != '\0')
                    printf(" \"%s\"", opt);
            printf("\n");
        }
    }
    return 0;
}

static int cmd_set(tool_t *t, const char *name, const char *prefix)
{
    if (load_all(t) < 0)
        return 2;
    int count = t->device.field_count < MAX_FIELDS ? t->device.field_count : MAX_FIELDS;
    for (int id = 1; id <= count; id++) {
        crsf_param_t *p = &t->fields[id];
        if (!t->loaded[id] || p->type != PARAM_TEXT_SELECTION || strcasecmp(p->name, name) != 0)
            continue;
        int idx = param_option_index(p, prefix);
        if (idx < 0) {
            fprintf(stderr, "crsf-param: \"%s\" has no option starting with \"%s\" (options: %s)\n",
                    p->name, prefix, p->options);
            return 1;
        }
        char before[96], after[96];
        format_value(p, before, sizeof before);
        uint8_t buf[16];
        if (send_frame(t, buf, crsf_build_param_write(buf, sizeof buf, CRSF_ADDR_MODULE, (uint8_t)id,
                                                      (uint8_t)idx)) < 0 ||
            pump(t, 300) < 0 || read_field(t, (uint8_t)id) < 0)
            return 2;
        format_value(p, after, sizeof after);
        printf("%s: %s -> %s\n", p->name, before, after);
        return p->value == idx ? 0 : 1;
    }
    fprintf(stderr, "crsf-param: no selectable setting named \"%s\" (try: list)\n", name);
    return 1;
}

int main(int argc, char **argv)
{
    int baud = 921600, opt;
    while ((opt = getopt(argc, argv, "b:")) != -1) {
        if (opt != 'b')
            goto usage;
        baud = atoi(optarg);
    }
    int rest = argc - optind;
    if (rest < 2 || baud <= 0)
        goto usage;
    const char *dev = argv[optind], *cmd = argv[optind + 1];
    bool is_list = !strcmp(cmd, "list") && rest == 2;
    bool is_set = !strcmp(cmd, "set") && rest == 4;
    if (!is_list && !is_set)
        goto usage;

    static tool_t t;
    t.fd = serial_open(dev, baud);
    if (t.fd < 0) {
        fprintf(stderr, "crsf-param: %s: %s\n", dev, strerror(errno));
        return 2;
    }
    crsf_deframer_init(&t.d);
    uint16_t ch[CRSF_NUM_CHANNELS];
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = crsf_us_to_ch(1000);         /* throttle and AUX low: disarmed */
    ch[0] = ch[1] = ch[3] = CRSF_CH_MID;
    crsf_build_rc_frame(t.rc, ch);

    int rc = find_module(&t);
    if (rc != 0) {
        fprintf(stderr, rc < 0 ? "crsf-param: I/O error\n" : "crsf-param: no TX module answered\n");
        close(t.fd);
        return rc < 0 ? 2 : 1;
    }
    printf("%s, ExpressLRS %u.%u.%u, %u settings\n", t.device.name, t.device.sw_major,
           t.device.sw_minor, t.device.sw_patch, t.device.field_count);
    rc = is_list ? cmd_list(&t) : cmd_set(&t, argv[optind + 2], argv[optind + 3]);
    close(t.fd);
    return rc;

usage:
    fprintf(stderr, "usage: crsf-param [-b baud] <device> list\n"
                    "       crsf-param [-b baud] <device> set \"<setting>\" <option>\n");
    return 2;
}
```

- [ ] **Step 4: Run the integration tests to see them pass**

Run: `make -C core integration`

Expected: PASS: `Ran 7 tests` … `OK`

- [ ] **Step 5: Commit**

```bash
git add core/tests/integration/test_param.py core/tools/crsf-param.c
git commit -m "core: crsf-param lists and changes ELRS module settings"
```

### Task 9: Check the real module

Hardware task. Never power the module without its antenna.

**Files:**
- Create: `docs/setup/module.md`

**Interfaces:**
- Consumes: `crsf-probe`, `crsf-param`
- Produces: a module verified to answer over USB, configured, versions recorded (FMEA #6)

- [ ] **Step 1: Add the module setup guide**

Create `docs/setup/module.md`:

````markdown
# ELRS TX module over USB (BetaFPV Micro 1W 2.4 GHz)

The Pi talks CRSF to the module through the module's own USB-C port (its CP2102
USB-serial chip shows up as `/dev/ttyUSB0`) instead of the JR-bay pin a radio uses.
Do this once per module. **Never power the module's RF stage without an antenna.**

## 1. Route CRSF to the USB port

1. Power the module (USB-C to the Pi is enough for setup).
2. Start its Wi-Fi access point. With no radio connected, ELRS TX modules start it by
   themselves after about a minute; if yours does not, use the button sequence from the
   BetaFPV manual. Join network `ExpressLRS TX` (password `expresslrs`).
3. Open `http://10.0.0.1/hardware.html`:
   - **CRSF RX pin = 3, CRSF TX pin = 1** (the ESP32 UART wired to the USB chip; the
     elrs-joystick-control author used exactly these values for this module).
   - **Disable Backpack/Logging**, which normally uses those same pins.
   - Save and reboot the module.
4. If it still does not answer in step 2 below, set the DIP switches to the
   "USB / firmware update" position (BetaFPV manual), which connects the USB chip to
   those pins.

## 2. Check that it answers

```bash
make -C core
./core/build/crsf-probe /dev/ttyUSB0            # 921600 baud, 5 s
```

Expected: `device 0xEE: "<module name>" ExpressLRS X.Y.Z (N parameters)` and exit status 0.
If nothing answers, try `-t 15` (ELRS cycles through baud rates while it looks for a
handset), then `-b 115200`. Whatever works goes into `baud =` in `deploy/crsf-core.conf`.
With the RX bound and the drone powered, `crsf-probe --rc /dev/ttyUSB0` must also print
`timing:` lines (about every 200 ms) and `link:` lines. **Propellers off for `--rc`.**

Record the firmware versions (FMEA #6: TX and RX must match):

| Date | TX module firmware | RX firmware | Binding phrase set | Checked by |
|------|--------------------|-------------|--------------------|------------|
|      |                    |             |                    |            |

## 3. Settings (no radio needed)

```bash
./core/build/crsf-param /dev/ttyUSB0 list
./core/build/crsf-param /dev/ttyUSB0 set "Packet Rate" 250Hz
./core/build/crsf-param /dev/ttyUSB0 set "Telem Ratio" 1:16
./core/build/crsf-param /dev/ttyUSB0 set "Max Power" 100
./core/build/crsf-param /dev/ttyUSB0 set "Dynamic" Off
./core/build/crsf-param /dev/ttyUSB0 set "Model Match" Off
```

Setting names and options differ between ELRS versions: use the names `list` prints.
Why these values:
- **250 Hz**: USB adds up to about 1 ms of timing noise, so faster rates gain nothing here.
- **Telemetry 1:16**: battery and flight mode (`!FS!`) arrive often enough to confirm a
  failsafe within the C3 budget.
- **100 mW, Dynamic off**: on USB power a 1 W module browns out and reboots in a loop if
  asked for more. Higher power needs the module's own supply (XT30 or JR-bay pins, see
  the BetaFPV manual) and a new FMEA review. Constant power keeps tests repeatable.

Stop crsf-core first once it is installed (`sudo systemctl stop crsf-core`): only one
program can use the port.
````

- [ ] **Step 2: Route CRSF to the module's USB port**

Follow `docs/setup/module.md` §1 on the module (Wi-Fi page `http://10.0.0.1/hardware.html`: CRSF RX pin 3, TX pin 1, Backpack off; DIP switches if needed).

- [ ] **Step 3: Probe the module**

Run: `make -C core && ./core/build/crsf-probe /dev/ttyUSB0`

Expected: `device 0xEE: "<module name>" ExpressLRS X.Y.Z (N parameters)` and exit status 0 (`echo $?`). If it prints `no CRSF device answered at 921600 baud`, retry with `-t 15`, then `-b 115200`, and write down the baud that works.

- [ ] **Step 4: Read and set the module settings**

```bash
./core/build/crsf-param /dev/ttyUSB0 list
./core/build/crsf-param /dev/ttyUSB0 set "Packet Rate" 250Hz
./core/build/crsf-param /dev/ttyUSB0 set "Telem Ratio" 1:16
./core/build/crsf-param /dev/ttyUSB0 set "Max Power" 100
./core/build/crsf-param /dev/ttyUSB0 set "Dynamic" Off
./core/build/crsf-param /dev/ttyUSB0 set "Model Match" Off
```
Each `set` prints `<name>: <old> -> <new>` and exits 0. Use the exact names that `list` prints if yours differ.

- [ ] **Step 5: Probe with RC frames (propellers off)**

Run: `./core/build/crsf-probe --rc -t 10 /dev/ttyUSB0`

Expected: With the drone powered and bound (propellers off): `timing: interval 4000.0 us (250.0 Hz)` lines (the rate set in the previous step) and `link:` lines with uplink LQ near 100 %.

- [ ] **Step 6: Record the versions**

Fill in the table in `docs/setup/module.md` §2 (TX firmware from `crsf-probe`, RX firmware from the receiver's Wi-Fi page or Betaflight's CRSF device list) and the baud that worked. If it is not 921600, note it there: Milestone 3's `deploy/crsf-core.conf` must use it.

- [ ] **Step 7: Commit**

```bash
git add docs/setup/module.md
git commit -m "docs: module setup and recorded firmware versions"
```

## Done when

- `make -C core test` and `make -C core integration` pass (37 unit tests, 7 integration tests).
- The real module answered `crsf-probe`, its settings were set with `crsf-param`, and the versions are recorded.
- If the module did **not** answer over USB, stop here and raise it with the team. Milestone 3 depends on it (spec §9).
