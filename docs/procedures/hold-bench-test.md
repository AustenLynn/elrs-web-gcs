# Hold-then-land bench test: two phones, local and through the tunnel

For the two-stage failsafe (`docs/superpowers/specs/2026-10-21-hold-then-land-failsafe-design.md`).
Written 2026-10-22. **Not run yet.** It runs after the team approves the spec (§8 there); until then
the Pi has `hold_ms = 0` and this build is not installed (`docs/HANDOFF.md` §6).

**Propellers off, for every step.** Setup:
- the drone is on its battery, bound to the TX module, as in `docs/procedures/m3-bench-test.md`;
- the module is on its XT30 supply, **2S, never 3S**, **antenna on**, and on the Pi's USB;
- two pilot accounts, `ana` and `luis` (`docs/HANDOFF.md` §6), each signed in on its own phone;
- `gcs-gateway` running; `cloudflared` started for the tunnel part (kill it when the test ends).

**Bench values** in `/etc/gcs/crsf-core.conf` (never flight values; restart `crsf-core` after editing,
and use the new gateway config with `eventLog`):

```
hold_ms = 5000
hold_throttle = 450
land_ms = 3000
```

`crsf-core` refuses to start with `hold_ms` > 0 and no `hold_throttle` or `land_ms`. Put the
settings back to `hold_ms = 0` when the bench ends, unless the team approved flying with them.

Watch while you test:
- terminal 1: `crsf-ctl watch` (state, `HOLD x.x s`, the hold events, the channels);
- terminal 2: `sudo tail -f /var/log/crsf-core/events.jsonl` (state lines, `hold`, `resumed`, `taken`,
  `landing`, and the stick lines while armed);
- terminal 3: `sudo tail -f /var/log/gcs-gateway/events.jsonl` (the connection log).

In each step ana flies (phone A, armed, throttle up a little), luis waits (phone B, `Estás en
espera…`). Everything is written for the pilots in Spanish; the log lines are English.

| # | Step | Expected |
|---|------|----------|
| 1 | **Hold → take.** Kill ana's tab (or Esc). On phone B press «Tomar el control» inside the 5 s | banner `ana perdió la conexión · aterriza en N s` over the video; `watch` shows `HOLD`: ARM high, sticks centred, throttle 450, CH6 low; after the take B shows `TIENES EL CONTROL`, throttle starts at 450 (no jump); `watch` never shows ARM low; log: `hold`, `taken`, then HOLD→ARMED |
| 2 | **Hold → land.** Same loss; on B press «Aterrizar» | `Aterrizando…`; throttle at minimum, ARM high for `land_ms`; then FAILSAFE (`cmd_timeout` or `pilot_lost`, the reason that started the hold); log: `hold`, `landing` |
| 3 | **Hold → lands by itself.** Same loss; nobody presses anything | after `hold_ms` the state goes to LANDING, after `land_ms` to FAILSAFE; the time between `hold` and `landing` is about `hold_ms` |
| 4 | **Resume.** Phone A in airplane mode for 2 s, then off (phone Wi-Fi back on) | `hold`, then `resumed` if A's link returned on the same connection; A flies on; toast `Conexión recuperada`. If A's socket closed first the log shows `pilot_lost` instead and there is no resume: A rejoins at the back of the queue. Write down which one you saw |
| 5 | **The four above with both phones on the tunnel URL** (`https://<name>.trycloudflare.com`). Repeat 1, 2, 3 and 4 | the same results. In `/var/log/gcs-gateway/events.jsonl`: `join`, `seat`, `leave` lines name `ana` and `luis` with `"via":"tunnel"`; `gap` lines (> 250 ms between ana's commands) and `stale` lines appear when the tunnel stalls; the loss shows as `leave` or a `gap` before `hold` |
| 6 | **Desarmar during a hold.** Loss as in 1; on B take control, then Desarmar. Also: loss, and press Desarmar on A's page if it is still open | motors stop at once: ARM low in the next frame, DISARMED; `hold`, `taken` and no `landing` |

Run 1–4 first on the local Wi-Fi (`https://<pi>:8443`, `local` in the log), then 5 on the tunnel.
After each step clear the failsafe (`Limpiar failsafe`, throttle 0) and re-arm.

## Results

| Step | Path (local / tunnel) | Expected | Seen | Pass |
|------|-----------------------|----------|------|------|
| 1 hold → take | local | | | |
| 2 hold → land | local | | | |
| 3 hold → lands by itself | local | | | |
| 4 resume | local | | | |
| 5.1 hold → take | tunnel | | | |
| 5.2 hold → land | tunnel | | | |
| 5.3 hold → lands by itself | tunnel | | | |
| 5.4 resume | tunnel | | | |
| 6 Desarmar during a hold | local | | | |
| 6 Desarmar during a hold | tunnel | | | |

Tested by / date / phones and browser versions / tunnel start time (UTC):

**After the bench:** the flight that measures `hold_throttle` and `land_ms` (spec §8 item 3) comes
only after the team approves. Put `crsf-core.conf` back to `hold_ms = 0` until then.
