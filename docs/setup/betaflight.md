# Betaflight configuration for the bridge

Use Betaflight Configurator over USB to the flight controller. **Propellers off.**

## Receiver
- Ports tab: *Serial RX* on the UART wired to the ELRS receiver.
- Receiver tab: *Serial (via UART)*, provider **CRSF**, channel map **AETR1234**,
  telemetry **on** (Configuration tab).

## Modes (Modes tab)

| Mode | Channel | Range | Sent by crsf-core |
|------|---------|-------|-------------------|
| ARM | AUX1 (CH5) | 1700–2100 | 2000 µs when armed, 1000 µs otherwise |
| FAILSAFE | AUX3 (CH7) | 1700–2100 | 2000 µs in failsafe, 1000 µs otherwise |
| your flight modes | AUX2 (CH6) | 900–1300 / 1300–1700 / 1700–2100 | "Modo 1/2/3" = 1000/1500/2000 µs |

ExpressLRS sends AUX1 with every packet, which is why ARM must be AUX1. crsf-core
refuses any other `ch_arm`.

## Failsafe (Failsafe tab or CLI)
- **Switch mode = STAGE2**: the FAILSAFE switch starts the stage-2 procedure at once.
- **Procedure**: DROP for bench and tethered tests. For flight, LAND or GPS Rescue (needs
  GPS): a decision for the team and mentor, made for the test site.
- **Guard time ≤ 0.5 s** so that a lost *radio* link also meets C3 (< 1 s): Betaflight,
  not the bridge, handles that segment.

```
get failsafe
set failsafe_switch_mode = STAGE2
set failsafe_procedure = DROP
set failsafe_delay = 5
save
```

`get failsafe` shows the exact names and units in your firmware (`failsafe_delay` is in
tenths of a second); adapt the commands if they differ.

## Check
With crsf-core running (`docs/procedures/m3-bench-test.md` goes through it step by step):
`crsf-ctl pilot`, press `f` → the Modes tab shows FAILSAFE active and the flight-mode
telemetry reads `!FS!` (`!FS!*` while disarmed).
