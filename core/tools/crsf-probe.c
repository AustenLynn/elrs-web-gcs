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
