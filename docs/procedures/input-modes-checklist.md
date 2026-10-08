# Input modes: bench checklist (touch, keyboard, step)

Verifies the pilot page's three input modes against the real module and the Aquila20.
Design: `docs/ARCHITECTURE.md` §5.2.

**Propellers off.** Before you start:
- crsf-core and the gateway are running on the Pi; the drone is bound and on its battery;
- the module is on its XT30 supply and on the Pi's USB;
- one terminal shows `crsf-ctl watch` (read-only, safe while the gateway runs);
- a computer with a keyboard and an Android phone are on the same network as the Pi.

Channel values in `watch`: 192 = 1000 µs (low), 992 = centre, 1792 = 2000 µs (high).
CH1 roll, CH2 pitch, CH3 throttle, CH4 yaw, CH5 ARM, CH6 flight mode.

| # | Device | Step | Expected | Result |
|---|--------|------|----------|--------|
| 1 | PC | Open `https://<pi>:8443` | the picker shows **Teclado** selected; key guide under the cockpit | |
| 2 | Phone | Open the same address | the picker shows **Táctil** selected; two sticks | |
| 3 | PC | `Tomar control`, hold **W** about 1 s | CH3 rises steadily (~50 %/s) and stays when W is released | |
| 4 | PC | Hold **S** until CH3 is low; hold **R** 1 s | ARMADO; CH5 = 1792; motors spin | |
| 5 | PC | Hold **↑**, then **←**, then **D** | CH2 above centre, CH1 below centre, CH4 above centre; each back to 992 on release | |
| 6 | PC | Press **Space** | DESARMADO at once; CH5 = 192; motors stop | |
| 7 | PC | Arm again (R), then try to click **Prueba** | the mode buttons are disabled while armed | |
| 8 | PC | Press **Esc** | control released; FAILSAFE `cmd_timeout` within ~0.3 s; CH5 = 192; motors stop | |
| 9 | PC | Clear the failsafe (hold the banner button 2 s), switch to **Prueba**, `Tomar control` | step panel visible; throttle limit 30 % | |
| 10 | PC | Click **+** on Acelerador twice | target 10 %; CH3 climbs to ~10 % over about half a second, no jump | |
| 11 | PC | Type 80 in Acelerador, press Enter | clamped to 30 % with a notice; CH3 ramps to 30 % | |
| 12 | PC | Arm is refused (throttle 30 %); press **NEUTRO** | CH1–CH4 back to neutral at once (throttle 192) | |
| 13 | PC | Arm (R), then try the **50 %** limit button | disabled while armed; disarm (Space) | |
| 14 | Phone | Hold-to-arm, fly the sticks with both thumbs, tap Desarmar | unchanged touch behaviour | |
| 15 | Both | Repeat 8 with the phone locked instead of Esc | FAILSAFE within ~0.3 s | |

**Rule:** disarm before anyone touches the drone or its battery.

Tested by / date / devices and browsers:
