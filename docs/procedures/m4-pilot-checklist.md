# Milestone 4 checklist: pilot web app on a PC and an Android phone

Adapted on 2026-10-07 from the M4 plan's Betaflight version: the drone is a BetaFPV Aquila20 HD
(`fc_profile = aquila20`, see `docs/setup/aquila20.md`).

**Propellers off.** The bench is set up as in the M3 test, with `gcs-gateway` running and no
`crsf-ctl pilot` session open. The PC and the phone are on the same network as the Pi.
Open `https://<pi>:8443`, where `<pi>` is the Pi's address on that network
(`hostname -I`, or `pi-iot-05.local`).

Since 2026-10-20 pilots sign in. Before the bench, create two pilot accounts, `ana` (admin) and
`luis`, as in `docs/HANDOFF.md` §6. On each device, «Iniciar sesión como piloto» before step 3.

**Amended 2026-10-22 (hold-then-land,
`docs/superpowers/specs/2026-10-21-hold-then-land-failsafe-design.md`).** Steps 7, 8, 11 and 12 say
"motors stop" for `hold_ms = 0`, the default and the setting until the team's §8 sign-off. With the
hold on (bench values, `docs/procedures/hold-bench-test.md`), the drone holds, then lands, then
FAILSAFE: the motors stop after `hold_ms` + `land_ms`, or at once with Desarmar. The old steps 15 and
16 (ready standby, automatic handover) are replaced by the ones below.

| # | Step | Expected | PC | Phone |
|---|------|----------|----|-------|
| 1 | Open `https://<pi>:8443` | the certificate warning appears once; accept it ("Advanced → continue") | | |
| 2 | Wait 2 s | Navegador, Núcleo, TX and Dron all green; battery and "Normal" shown | | |
| 3 | "Tomar control" | phone: full screen, landscape; the dead-man text disappears | | |
| 4 | Left stick to the bottom, hold "Armar" 1 s | ARMADO; **motors spin** | | |
| 5 | Move both sticks | motors react (throttle raises speed); the sticks spring back, except the throttle | | |
| 6 | Tap "Sport", then "Manual", then "Normal" | the mode line shows "Sport", "Manual", "Normal" | | |
| 7 | Phone: press Home, then come back | FAILSAFE banner within ~0.3 s ("dejaron de llegar comandos"); **motors stop at once** | — | |
| 8 | PC: click another window | FAILSAFE banner (dead-man: the window lost focus); **motors stop** | | — |
| 9 | Hold "Limpiar failsafe" 2 s with the throttle at 0 | DESARMADO; motors stay off | | |
| 10 | Open the page on the second device, not signed in | a spectator: no controls; the status line shows `Piloto: ana · En espera: —` | | |
| 11 | Arm, then close the pilot tab | FAILSAFE `pilot_lost` ("el piloto se desconectó"); motors stop | | |
| 12 | Arm, then turn off Wi-Fi on the pilot device | FAILSAFE within 1 s (`cmd_timeout`); motors stop | | |
| 13 | Tap Fast, then Slow | the mode line shows "Normal · Fast", then "Normal · Slow" | | |
| 14 | Turtle on with the drone upright | nothing happens on the drone; the Turtle button is highlighted; turn it off again | | |
| 15 | PC flies as ana, armed with the throttle up (hold on). Phone: sign in as luis; the phone says `Estás en espera…`. Turn off Wi-Fi on the PC | the phone shows the banner `ana perdió la conexión · aterriza en N s` over the video; press «Tomar el control»: `TIENES EL CONTROL`; **the motors keep spinning**; the phone's throttle starts at the hold throttle | | |
| 16 | The same, but nobody presses anything (or the phone presses «Aterrizar») | LANDING (`Aterrizando…`), then FAILSAFE; **motors stop after `hold_ms` + `land_ms`** (at once with `hold_ms = 0`) | | |
| 17 | While someone flies, open `/admin` as ana on the other device | the flying pilot's «Quitar» is disabled: `Está volando: no se puede quitar` | | |

**Rule:** press "Desarmar" before anyone touches the drone or its battery.

**Pilot briefing (Spanish, read aloud before flying):** «Desarmar es la única forma de detener los
motores en vuelo; soltar el control (Esc, pestaña oculta) ahora mantiene la posición y luego aterriza.»
In English: Desarmar is the only way to stop the motors in flight; letting go (Esc, hidden tab) now
holds, then lands.

Tested by / date / browser versions:
