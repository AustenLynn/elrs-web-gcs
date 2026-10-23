# Two-stage failsafe: hold, then land: Design

**Date:** 2026-10-21 · **Amends:** `2026-10-05-elrs-web-gcs-design.md` §3.2 and §5.3,
`2026-10-07-aquila20-profile-design.md` §3.3, `2026-10-20-pilot-auth-handover-design.md` §2 (goals
4–5), §3 (A7, A9, A10), §4.3–4.5, and `docs/ARCHITECTURE.md` (failure table, §7.4).
**Status:** agreed in conversation, part by part; this spec is for the team's review. **It changes a
safety rule: nothing here may fly before the team approves it (§8).**

## 1. Why

When the pilot's commands stop in flight today, crsf-core fails safe within 300 ms. Under the
`aquila20` profile that drops ARM, the motors stop at any height, and the drone falls.

Every in-flight cut on record came from that path, not from the radio:
- 2026-10-09 20:07:49: `cmd_timeout` 20 s into a flight;
- 2026-10-14 17:38:54: `cmd_timeout` at 83 % throttle over the tunnel. The page kept sending, and
  the network delivered the commands late and in bursts (144, 248, 139, 103, 204 ms), then nothing
  for 300 ms (flight report §4).

The automatic handover (2026-10-20) only helps when a second pilot is already "ready" and their first
command reaches the core within 300 ms of the switch. On the Pi that window is tight (the handover
e2e test fails about one run in three for exactly this reason).

The team wants the drone to **stay in the air for a few seconds** instead: long enough for the main
pilot's link to come back, or for a second pilot to decide what happens.

## 2. Goals, non-goals, anti-goals

**Goals**
1. When the active pilot's commands stop, the drone **holds**: still armed, sticks centred, holding
   its height, for **5 seconds**.
2. During those 5 s the **second pilot chooses**: **take control** or **land**.
3. If the main pilot's commands come back before anyone chooses, **the main pilot keeps flying**.
4. If nobody chooses within 5 s, **the drone lands by itself**, then disarms.
5. The second pilot sees the choice **without losing the video**.

**Non-goals**
- Changing what happens when the **radio link** to the drone is lost. The Aquila20's own firmware
  stops the motors at once (measured), and nothing on the ground can change that.
- Holding position against drift. The drone holds height in Normal mode; it may drift sideways.
- A hold for the Betaflight profile's own failsafe stages. The core's hold applies to both profiles
  (§4.1), but Betaflight's procedure after the core's FAILSAFE is unchanged.
- Changing how the relay (M7) works, beyond what the shared queue already does.

**Anti-goals: these would be failures even if everything else worked**
- **The drone falls during the hold or the landing** because the hold or landing throttle is wrong.
  That is why the hold can't be switched on before the hover throttle is measured (§4.2).
- **Desarmar, the manual FAILSAFE, a gateway crash or a radio-link loss stops working instantly.**
  Those stay instant, exactly as today.
- **The throttle jumps** when the second pilot takes control, or when the main pilot resumes.
- **A safety decision made in the gateway or the page.** The hold, the landing, the countdown and who
  may take over are decided in crsf-core (CLAUDE.md). The gateway forwards; the page shows.
- **Someone who isn't a signed-in pilot can take control or trigger the landing.**

## 3. Decisions taken in conversation

| # | Decision |
|---|---|
| B1 | **Two stages:** first hold, then land. No more instant motor stop when the pilot's commands stop. |
| B2 | **Hold time: 5 s.** |
| B3 | **During the hold the drone stays still in the air:** armed, sticks centred, holding height. |
| B4 | **The second pilot chooses:** «Tomar el control» or «Aterrizar». |
| B5 | **Nobody chooses → it lands by itself** (not a motor stop). |
| B6 | **Every second pilot gets the choice.** It replaces the automatic handover: nothing switches pilots until the second pilot presses «Tomar el control». |
| B7 | **The main pilot's commands come back before a choice → the main pilot keeps flying.** |
| B8 | **The choice is a banner over the video** (mockup B), so the camera view stays visible. |
| B9 | **No instant motor stop for the second pilot during the hold:** the banner has only the two choices. To stop the motors, the second pilot takes control, then presses Desarmar. |

## 4. Design

### 4.1 crsf-core: two new states (the safety part)

The state machine (main spec §5.3) gains **HOLD** and **LANDING** between ARMED and FAILSAFE:

```
                 cmd_timeout or pilot_lost (active session), hold enabled
    ARMED ──────────────────────────────────────────────────────▶ HOLD
      ▲   ◀── fresh command from the session that was flying (B7) ──┤
      │                                                              │ TAKE from the standby session
      │   ◀── first fresh command from the new session ─────────────┤ (session switches, still HOLD)
      │                                                              │
      │                                            LAND, or hold_ms over
      │                                                              ▼
      └──────── first fresh command from the active session ──── LANDING
                (only after a TAKE during LANDING, *my call*)        │ land_ms over
                                                                     ▼
                                                             FAILSAFE (latched, as today)

  From ARMED, HOLD or LANDING, these go straight to FAILSAFE, as today:
  Desarmar → DISARMED; manual FAILSAFE; gateway_lost; rf_lost; an unexpected SESSION.
```

- **Entering HOLD.** The same two events that fail safe today, `cmd_timeout` and `pilot_lost` for the
  active session, enter HOLD instead when the hold is enabled (§4.2). The hold timer starts
  (`hold_ms`, 5000).
- **Not from the ground** (*my call*). If the last throttle applied before the loss was at or below
  `throttle_arm_max` (5 %), the drone may be sitting on the ground, and `hold_throttle` would lift it.
  Then the core skips HOLD and goes straight to LANDING (throttle minimum, ARM high, then disarm):
  harmless on the ground, and right for a drone that was already coming down. The second pilot can
  still take control during that LANDING.
- **Outputs in HOLD:** ARM high, roll/pitch/yaw centred, throttle = `hold_throttle`, flight mode
  **Normal** (CH6 low) whatever the pilot was flying in (*my call*: Normal is the mode that holds
  height), speed (CH7) unchanged, turtle off. In the `betaflight` profile the FAILSAFE switch stays low.
- **Resume (B7).** A fresh command from the session that was flying (same session, higher sequence)
  ends the hold: back to ARMED, and that command applies at once, as after any short stall today.
  This only happens for `cmd_timeout`. After `pilot_lost` that session is gone (its socket closed);
  the pilot comes back with a new connection and a new session, at the back of the queue, so they
  may be the second pilot and get the choice themselves.
- **TAKE (B4).** New IPC message `TAKE (u32 session)`, gw → core. Accepted only from the registered
  standby session during HOLD or LANDING. The active session becomes that session and the standby is
  cleared. The state **stays HOLD (or LANDING) until the new session's first fresh command arrives**;
  then ARMED, and that command applies. There is no separate 300 ms window for the first command:
  the countdown keeps running, and if it runs out first, the drone lands (from HOLD) or goes on
  landing (from LANDING) as if nobody had chosen. After that first command, the normal
  `cmd_timeout_ms` applies to the new pilot, and a later loss starts a new HOLD.
- **LAND (B4).** New IPC message `LAND (u32 session)`, gw → core. Accepted only from the registered
  standby session during HOLD. Goes to LANDING at once.
- **Outputs in LANDING:** ARM high, sticks centred, **throttle minimum**, flight mode Normal. In Normal
  mode with the throttle at minimum the drone comes down and lands itself, then idles on the ground
  (flight report §1 item 3: seen with the physical controller). After `land_ms`, the core enters
  FAILSAFE as today (ARM low, latched). The FAILSAFE reason is the one that started the hold
  (`cmd_timeout` or `pilot_lost`), so the logs and the page still say why the flight ended.
- **Who has the seat after an unattended landing** (*my call*, matching today). If the hold started
  with `pilot_lost`, the core clears the active session when it enters FAILSAFE, as
  `safety_pilot_lost()` does today, so the gateway gives the seat to the queue head. If it started
  with `cmd_timeout`, the pilot's page is still connected and keeps the seat; they clear the FAILSAFE
  (ack) as today.
- **TAKE during LANDING** is allowed (*my call*): it lets the second pilot steer away from an
  obstacle during the descent.
- **Instant paths stay instant.** Desarmar from the active session, the manual FAILSAFE, `gateway_lost`,
  `rf_lost` and an unexpected SESSION act exactly as today from HOLD and LANDING too. During HOLD the
  active session is still the pilot who dropped out (until a TAKE); their Desarmar, if it arrives, is
  obeyed.
- **The old automatic handover goes away (B6).** `try_handover()` and the "handover pending" state
  are replaced by HOLD + TAKE. The `handover` event to the gateway is replaced by the events in §4.4.
- **DISARMED and FAILSAFE are unchanged.** A command timeout while disarmed does nothing, as today.
  A latched FAILSAFE still needs the pilot's ack.

### 4.2 Settings (`crsf-core.conf`)

| Key | Meaning | Default |
|---|---|---|
| `hold_ms` | How long the drone holds before landing by itself. **0 = off**: today's instant FAILSAFE. | 0 in the code; `deploy/crsf-core.conf` sets 5000 **only after §8** |
| `hold_throttle` | Throttle (0–1000, as on the wire) that holds height in Normal mode. | none. **Required when `hold_ms` > 0**: config validation refuses to start without it |
| `land_ms` | How long LANDING keeps ARM high at throttle minimum before disarming. | none; required when `hold_ms` > 0. Sized from the measured descent (§8) |

- `hold_throttle` has **no default on purpose**: it has never been measured on the Aquila20 (flight
  report §4), and a wrong value makes the drone climb or drop during the hold.
- Validation ranges are the builder's call, within: `hold_ms` 1000–10000, `land_ms` 1000–30000.

### 4.3 Gateway (`hub.js`)

- **The second pilot is the queue head.** «Listo» goes away: the gateway sends `STANDBY` with the
  session of whoever is first in the queue, whenever that changes (join, leave, take). No "ready" flag.
- **New browser messages** `{t: "take"}` and `{t: "land"}`, accepted only from the queue head's page
  and forwarded as `TAKE` / `LAND` with that page's session. Anything else is refused as today. The
  core checks the session again and decides.
- **Following the core.** When the core reports a take completed (§4.4), the hub moves the new pilot to
  the seat and the old pilot's connection, if still open, to the back of the queue ("Perdiste el
  control: ahora vuela luis"), as today after a handover. The hub never moves anyone on its own.
- **Takeover sticks.** The page that takes control starts from **what the drone is doing now** (the
  hold outputs, from the channels in STATUS), not from the old pilot's last command (*my call*: during
  HOLD the drone is at `hold_throttle` with sticks centred, so that is what must not jump).
- **Resume.** Nothing changes in the gateway: the old pilot's commands simply reach the core again.

### 4.4 Core → gateway: status and events

- `STATUS.state` gains `HOLD` and `LANDING`, and STATUS gains the **time left** in the current stage
  (ms), so every page can show the same countdown. Field layout is the builder's call.
- New events (replacing `handover`), all with the session and the reason that started the hold:
  `hold` (entered), `resumed` (B7), `taken` (new session's first command arrived), `landing` (LAND
  pressed or `hold_ms` over), then the existing FAILSAFE status when `land_ms` ends.
- Every one of them goes to the evidence log (`events.jsonl`) with a timestamp, plus the stick log
  as today while armed.
- **Amendment 2026-10-23 (ruling R1, taken while building):** `taken` is reported when the core
  accepts the TAKE, not when the new session's first command arrives: the hub needs it to seat the
  taker, whose page sends no command before it is seated. The new session's first command is the
  state change HOLD (or LANDING) → ARMED, visible in STATUS and in the evidence log.

### 4.5 Pilot page

- **Second pilot (queue head), during HOLD:** a banner over the video, not covering it (B8):
  *"ana perdió la conexión · aterriza en 4 s"*, with **«Tomar el control»** and **«Aterrizar»**.
  During LANDING: *"Aterrizando…"* with **«Tomar el control»** only.
  - **Tomar el control** engages the page at once (full screen and orientation lock, as «Tomar
    control» does today), seeds every input from the drone's current outputs (§4.3), and starts
    sending. The banner then shows "TIENES EL CONTROL", as today.
  - **Aterrizar** sends `land`; the banner shows "Aterrizando…".
- **Second pilot, outside a hold:** "Estás en espera. Si ana pierde la conexión, podrás tomar el
  control o aterrizar." No «Listo» button, no arm/disarm/FAILSAFE (A10 stays). *Amendment
  2026-10-23 (final review):* with `hold_ms` = 0 there is no rescue, so the text is "Estás en espera.
  Si ana pierde la conexión, el dron se detiene." (the core reports its hold length in STATUS).
- **Main pilot:** if their link comes back during the hold, they keep flying; their page shows a short
  toast ("Conexión recuperada"). If the second pilot took over, they see "Perdiste el control: ahora
  vuela luis", as today.
- **Everyone else** (spectators, pilots further back in the queue): the same countdown text, without
  buttons (*my call*).
- The state pill in the bar shows **ESPERA · SIN PILOTO** during HOLD and **ATERRIZANDO** during
  LANDING.
- **Letting go changes meaning (A9).** Esc, a hidden tab or a lost focus now starts a HOLD, then a
  landing, with or without a second pilot. It no longer stops the motors. **Desarmar is the way to stop
  the motors**, as A9 already said for the case with a ready standby.

### 4.6 Messages, summarised

| Hop | Change |
|---|---|
| browser → gateway | new `take`, `land`; `ready` removed |
| gateway → browser | `status` carries `HOLD` / `LANDING` and the time left; events `hold`, `resumed`, `taken`, `landing` |
| gateway → core | new `TAKE (u32 session)`, `LAND (u32 session)`; `STANDBY` now always names the queue head |
| core → gateway | `STATUS` gains the time left; events `hold`, `resumed`, `taken`, `landing` replace `handover` |

## 5. Tests the builder must include

- **core unit (`safety.c`):** `cmd_timeout` and `pilot_lost` enter HOLD when enabled and FAILSAFE when
  `hold_ms` = 0; HOLD outputs; straight to LANDING when the last throttle was ≤ `throttle_arm_max`;
  session cleared after a `pilot_lost` landing, kept after a `cmd_timeout` one; resume by the same session (not after `pilot_lost`); TAKE only from the
  standby session, only in HOLD/LANDING; state stays HOLD until the new session's first command; LAND
  only from the standby in HOLD; `hold_ms` and `land_ms` expiry; FAILSAFE reason kept; Desarmar,
  manual, `gateway_lost`, `rf_lost`, SESSION still instant from HOLD and LANDING; old session refused
  after a TAKE; a second loss after a take starts a new HOLD.
- **core config:** `hold_ms` > 0 without `hold_throttle` or `land_ms` is refused; ranges.
- **core integration (fake TX module):** an armed pilot stops sending → frames show ARM high, sticks
  centred, throttle = `hold_throttle`, CH6 low for `hold_ms`; then throttle minimum for `land_ms`; then
  ARM low. The same with a TAKE (the new pilot's commands reach the channels with no ARM-low frame),
  with a LAND, and with a resume.
- **gateway:** STANDBY follows the queue head; `take`/`land` refused from anyone but the queue head;
  the hub follows `taken`; old pilot to the back of the queue.
- **browser e2e:** replaces the handover e2e. Two pages: ana flies, ana's page is killed (and, in a
  second test, Esc), luis sees the banner over the video, presses «Tomar el control», and the aircraft
  never sees ARM low and the throttle doesn't jump from `hold_throttle`. A third test: nobody chooses →
  hold, landing, ARM low at the expected times. Without the 300 ms first-command window, the e2e
  flakiness found on 2026-10-21 should go away; the builder confirms that on the Pi.
- **Bench (propellers off):** M4 checklist steps for hold → take, hold → land, hold → land by itself,
  and resume (turn the main pilot's Wi-Fi off and on within 5 s).

## 6. Left to the builder

Field names and layouts (IPC, STATUS, WebSocket), the validation ranges inside §4.2's limits, the
banner's exact look within mockup B, the toast wording, and how each input mode (touch, keyboard,
Prueba) is seeded from the drone's outputs. Marked *my call* above: Normal mode during the hold, TAKE
allowed during LANDING, no HOLD when the last throttle was at or below 5 % (straight to LANDING), the
seat after an unattended landing, seeding from the drone's outputs, spectators seeing the countdown.

## 7. Documentation changes

- Main spec §3.2 (failure table) and §5.3 (state machine): HOLD and LANDING.
- Aquila20 spec §3.3: "the drone cannot land itself" is no longer the design; it lands itself in
  Normal mode at throttle minimum.
- Handover spec: goals 4–5, A7, A9, A10, §4.3–4.5 amended (pointer to this spec).
- `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, the M4 checklist, and the pilots' briefing (Desarmar is
  the only way to stop the motors in flight).

## 8. Before it flies (team and bench)

1. **Team approval.** The motors keep running for up to `hold_ms` + `land_ms` (5 s + the landing) with
   no pilot. That replaces the original "stop the motors" rule (main spec §3.2, Aquila20 spec §3.3)
   and flight report §5 item 4.
2. **Criterion C3 (failsafe < 1 s).** With this design the core still reacts within 300 ms: it stops
   following the lost pilot and neutralises the sticks. But the motors stop only after the hold and the
   landing. The team (and the course) must agree that C3 is met by the reaction, not by the motor stop.
3. **Measure, on one flight in Normal mode with the physical controller at hand:** the throttle at which
   the drone holds height (`hold_throttle`), and how long it takes to land from the usual flying height
   at throttle minimum (`land_ms`, with margin).
4. **Bench first,** propellers off: every step in §5's bench list, then a low hover test.

## 9. Open items for the team

- **Hold time.** 5 s was chosen to leave time to decide. It is a setting; the first flights may suggest
  another value.
- **Sideways drift during the hold.** Unknown how far the Aquila20 drifts in 5 s with the sticks
  centred. Fly the first holds in an open space.
- **Relay (M7).** Relay pilots join the same queue, so a relay pilot at the head would get the choice.
  The relay adds latency to `take`; acceptable inside 5 s, but untested.
