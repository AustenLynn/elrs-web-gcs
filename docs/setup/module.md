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
| 2026-10-07 | BFPV 2G4Micro1W, ExpressLRS 3.3.0 (ae9df3), 921600 baud | BFPV AIO 2G4RX (built into the Aquila20 AIO board), ExpressLRS 3.5.6 | none: bound in bind mode | bench, with Claude Code |

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

## 4. Bench findings (2026-10-06/07, BetaFPV Micro 1W + Aquila20)

- **DIP switches:** 1–2 ON ("Update Firmware": USB-C ↔ ESP32 UART), 3–7 OFF. With 3–4 ON
  ("Operating Mode") nothing reaches USB. Never turn all of them on.
- **Power:** USB alone cannot run the 1 W module. It browns out, drops off USB and never
  starts Wi-Fi. Use the XT30 at 5–12 V: a bench supply at 8.0 V with a 1.0 A limit worked
  and drew 230 mA idle. **Never 3S (12.6 V): it destroys the power chip.**
- **Antenna:** a 5.8 GHz (video) antenna fits the module's connector but blocks binding.
  Check that the label says **2.4G**, and swap antennas only with the supply off.
- **Default `hardware.html`:** CRSF RX/TX pin 13 (half-duplex, JR bay) and backpack on
  pins 3/1 at 460800 baud. A full printout is in `docs/setup/elrs-micro-tx-default-hardware.pdf`.
  Changed to CRSF RX 3 / TX 1, backpack off. Restore from that PDF if needed.
- **"No handset":** the module's menu does not respond without a handset. Bind worked from
  the module's menu (Bind → press) while the Pi sent RC frames (`crsf-probe --rc -t 60`),
  with the drone in bind mode (battery on/off 3 times). `crsf-param <dev> run Bind` sends
  the same command over USB.
- **Result:** `crsf-probe --rc` showed uplink and downlink LQ 100 %, RSSI about −37 dBm,
  100 mW, battery telemetry 8.4 V, and flight-mode telemetry `S-NORMAL`.
- **The Aquila20 does not run Betaflight.** Its HDSC MCU (USB 0493:5740) runs BetaFPV's own
  firmware and does not answer MSP or the CLI. Spec D4 and the Betaflight-specific design
  (FAILSAFE AUX switch, `*`/`!FS!` flight-mode strings) do not apply to this drone. See the
  open decision in `docs/HANDOFF.md`.

