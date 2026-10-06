# Raspberry Pi: real-time setup and installation

## 1. Reserve CPU 3 for the frame loop (FMEA #1)

`/boot/firmware/cmdline.txt` is a **single line**; append to it, never add a new line.

```bash
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak
grep -q isolcpus /boot/firmware/cmdline.txt || sudo sed -i '1 s/$/ isolcpus=3 irqaffinity=0-2/' /boot/firmware/cmdline.txt
cat /boot/firmware/cmdline.txt        # still one line, ends with: isolcpus=3 irqaffinity=0-2
sudo reboot
```

After the reboot:

```bash
cat /sys/devices/system/cpu/isolated           # 3
cat /proc/irq/default_smp_affinity             # 7  (CPUs 0-2)
```

To undo: `sudo cp /boot/firmware/cmdline.txt.bak /boot/firmware/cmdline.txt && sudo reboot`.

## 2. Install and start

```bash
sudo deploy/install.sh
sudo systemctl start crsf-core
systemctl status crsf-core --no-pager
journalctl -u crsf-core -n 20 --no-pager
crsf-ctl status        # read-only status socket: safe even while flying
```

## 3. Check the real-time settings took effect

```bash
ps -eLo pid,tid,cls,rtprio,psr,comm | awk 'NR==1 || /crsf-core/'
```

Exactly one crsf-core thread must show `cls FF`, `rtprio 80`, `psr 3` (the frame loop).
The other thread is `TS` (normal scheduling). With `rt_required = true` the service
refuses to start if it cannot get these settings, and the journal says why.
