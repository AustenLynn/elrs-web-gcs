# Speed setting and turtle mode on the pilot page: Design

**Date:** 2026-10-14 · **Amends:** `2026-10-07-aquila20-profile-design.md` (CH7 is no longer fixed at S;
CH8 gets a function) and `2026-10-05-elrs-web-gcs-design.md` (control message, IPC CONTROL).
**Status:** design approved in conversation, section by section; this spec is for the team's review.

## 1. Why

The Aquila20's own radio has two functions the web controller lacks. From the drone's manual
(pp. 24–25):
- **Turtle mode** (switch SD, "TURTLE" on the OSD): after a landing upside down, the motors run in
  reverse to flip the drone back over.
- **Speed setting** (switch SC): FAST, MID or SLOW.

The pilot wants buttons for both. Until now crsf-core kept CH7 low (sensitivity S, the slowest) on
purpose, and nothing drove CH8.

## 2. What the drone does

| Function | Channel | Values | Source |
|---|---|---|---|
| Speed (SC) | **CH7** | low = SLOW (S), mid = MID (M), high = FAST (F) | bench 2026-10-07 (`aquila20.md`), manual |
| Turtle (SD) | **CH8** | high (2000 µs) = turtle | spike 2026-10-14, below |

**Turtle spike, 2026-10-14** (propellers off, ARM held low throughout). A throwaway script drove the
TX module directly and logged every flight-mode report. Each report is `<speed>-<mode>`.

| Drone | Channels | Reported |
|---|---|---|
| upright | CH8–CH12 high one at a time | `S-NORMAL` throughout |
| upside down | all spare channels low (15 s) | `S-NORMAL` (11 reports) |
| upside down | CH8 high | **`S-TURTLE` within 0.7 s** |
| upside down | CH8 low again (2 × 15 s) | **still `S-TURTLE`**: latched |
| turned upright by hand | all low | `S-NORMAL` within about 1 s |

So:
- turtle needs **upside down and CH8 high**;
- it **ends when the drone is upright again**, not when CH8 drops;
- the drone **reports it** as `X-TURTLE`.

**Not yet tested:** what the motors do when armed in turtle mode. This is bench step 3 in §6.

## 3. Decisions

1. **Turtle can be switched at any time**, like the physical switch. The drone only enters turtle
   when upside down.
2. **Speed can be changed at any time**, like the physical switch. The page starts at **Slow**.
3. **Both travel in every control message**, like the flight mode. This was chosen over separate
   "set" messages: the existing command rules (session, sequence numbers, 300 ms timeout) cover
   them, and a lost message is corrected 20 ms later.
4. **In FAILSAFE, turtle is forced off** (CH8 low) and speed is kept, as the sticks are centred and
   ARM dropped today.

## 4. Design

### 4.1 Messages

| Hop | Change |
|---|---|
| Page → gateway `ctl` | two new fields: `sp` (0..2: Slow, Mid, Fast) and `tu` (0 or 1) |
| Gateway | `sp` and `tu` are range-checked like `m`. **If missing, they default to 0**, so an older page keeps working. Invalid values drop the message, as today. |
| Gateway → core `0x02 CONTROL` | `u8 speed, u8 turtle` appended after `u8 mode` (2 bytes longer) |

The relay forwards `ctl` unchanged.

### 4.2 Core

- **Safety:**
  - `stick_cmd_t` gains `uint8_t speed` (clamped to 0..2) and `bool turtle`;
  - `rc_outputs_t` gains the same;
  - outputs follow the command, except in FAILSAFE, where `turtle = false` and `speed` is kept.
- **Config:**
  - new keys `ch_speed` (default 7) and `ch_turtle` (default 8).
  - Aquila20 profile: validation reserves CH7 and CH8 for them. A stick or switch channel set to
    either is refused, replacing today's "CH7 is never used".
  - Betaflight profile: they are not used; CH7 stays the FAILSAFE switch.
- **Channel map (Aquila20):**
  - `ch_speed` carries 1000 / 1500 / 2000 µs for speed 0 / 1 / 2;
  - `ch_turtle` carries 2000 µs when turtle is on, else 1000 µs.
- **Stick log:** the `sticks` lines get `"speed":0..2` and `"turtle":true|false`.

### 4.3 Pilot page

- **Footer**, next to the Normal / Sport / Manual buttons, in the same style:
  - **Slow / Mid / Fast** selector (starts on Slow);
  - **Turtle** on/off button, highlighted in the warning colour while on.
- **Keys** (keyboard and Prueba modes; both key guides list them):
  - **T** toggles turtle;
  - **4 / 5 / 6** choose Slow / Mid / Fast (number-pad digits too, as for 1 / 2 / 3).
- **"Modo FC" line:** shows the drone's report as mode and speed, e.g. `S-NORMAL` → **"Normal ·
  Slow"**, `F-SPORT` → "Sport · Fast". `X-TURTLE` → **"TURTLE"** in the warning colour, so the pilot
  sees whether turtle actually engaged.
- **Resets:**
  - after a failsafe and on an input-mode change: turtle off, speed kept;
  - on page load: Slow, turtle off.
- **Phones:** the extra buttons share the flight-mode row and wrap if needed.

## 5. Testing

- **C unit tests:**
  - channel map: CH7 levels per speed, CH8 per turtle, Aquila20 only; FAILSAFE drops CH8 and keeps CH7;
  - safety: clamping, and the FAILSAFE outputs;
  - config: CH7/CH8 reserved in Aquila20; Betaflight unchanged;
  - IPC: CONTROL encode and decode with the new bytes;
  - event log: `speed` and `turtle` in the `sticks` line.
- **Integration (real binary, fake TX):**
  - a pilot sending speed 2 and turtle 1 gives CH7 high and CH8 high;
  - FAILSAFE gives CH8 low and CH7 still high;
  - the stick log shows both.
- **Gateway:** range checks, the defaults when the fields are missing, and the encoded CONTROL length.
- **Page:**
  - controlMessage fields;
  - keys T and 4/5/6;
  - the reset rules;
  - "Normal · Slow" and "TURTLE" from the drone's text.
- **Browser:**
  - the turtle button and the speed buttons reach CH8 and CH7 through the real core;
  - the layout tests (640×360, portrait, desktop) pass, and screenshots are checked by eye.

## 6. Bench check (with the pilot, propellers off)

1. **Speed:** Slow / Mid / Fast; the drone reports `S-`, `M-`, `F-NORMAL`.
2. **Turtle:** drone upside down, Turtle on → page shows "TURTLE"; turn the drone upright → Normal again.
3. **Armed turtle flip, never tested:** upside down, Turtle on, arm, then move a stick a little. The
   motors should spin in reverse. Disarm, then Turtle off. Record the result in `aquila20.md`.

## 7. Documentation changes

- `docs/setup/aquila20.md`: channel table (CH7 speed, CH8 turtle) and the spike results (§2).
- `2026-10-07-aquila20-profile-design.md`: amendment note. CH7 is no longer fixed at S.
- `docs/ARCHITECTURE.md`: the `ctl` and CONTROL message tables, the channel map, the footer, keys and the stick log.
- `docs/procedures/m4-pilot-checklist.md`: rows for speed and turtle.

## 8. Risks

- **Turtle while armed in the air:** allowed by decision 1. The drone ignores CH8 unless upside
  down (spike), so it is harmless upright, but this was observed only while disarmed. Bench step 3
  confirms the armed behaviour.
- **Fast speed with the web controller:** the drone becomes more responsive. Combined with 50 Hz
  updates and tunnel delays (flight-test report §3), the pilot should start on Slow. The page
  starts there.
