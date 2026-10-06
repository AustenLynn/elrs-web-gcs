#define _GNU_SOURCE
#include "rtloop.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "chmap.h"
#include "crsf.h"
#include "crsf_telem.h"
#include "rt.h"
#include "serial.h"
#include "timeutil.h"

#define REOPEN_INTERVAL_NS (500 * NS_PER_MS)
#define MODULE_SILENT_NS   (1000 * NS_PER_MS)

static int32_t cmd_age_ms(const rtloop_t *l)
{
    if (!l->safety.have_cmd)
        return -1;
    int64_t age = (l->now_ns - l->safety.last_cmd_ns) / NS_PER_MS;
    return age > INT32_MAX ? INT32_MAX : (int32_t)age;
}

static void push(rtloop_t *l, event_kind_t kind, int32_t a, int32_t b, int32_t c, int32_t d,
                 uint32_t session, int32_t age, const char *text)
{
    core_event_t ev = { .kind = kind, .t_ns = l->now_ns, .a = a, .b = b, .c = c, .d = d,
                        .session = session, .cmd_age_ms = age };
    if (text != NULL)
        snprintf(ev.text, sizeof ev.text, "%s", text);
    mailbox_push_event(l->mb, &ev);
}

static void apply(rtloop_t *l, const core_cmd_t *c)
{
    safety_t *s = &l->safety;
    safety_state_t before = s->state;
    uint32_t session = s->session != 0 ? s->session : c->session;
    int32_t age = cmd_age_ms(l);
    refuse_t r = REFUSE_NONE;

    switch (c->kind) {
    case CMD_SESSION:      safety_session_start(s, c->session); break;
    case CMD_CONTROL:      safety_control(s, c->session, c->seq, &c->sticks, l->now_ns); break;
    case CMD_ARM:          r = safety_arm(s, c->session, l->now_ns); break;
    case CMD_DISARM:       safety_disarm(s); break;
    case CMD_ACK:          r = safety_ack(s, c->session, l->now_ns); break;
    case CMD_PILOT_LOST:   safety_pilot_lost(s, c->session); break;
    case CMD_FAILSAFE:     safety_trigger(s, FS_MANUAL); break;
    case CMD_GATEWAY_LOST: safety_gateway_lost(s); break;
    }
    if (r != REFUSE_NONE)
        push(l, EV_REFUSED, (int32_t)c->kind, (int32_t)r, 0, 0, c->session, age, NULL);
    if (s->state != before)
        push(l, EV_STATE, (int32_t)before, (int32_t)s->state, (int32_t)s->fs_reason, 0, session, age, NULL);
}

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    rtloop_t *l = user;
    crsf_msg_t m;
    l->last_rx_ns = l->now_ns;
    switch (crsf_decode(frame, len, &m)) {
    case CRSF_MSG_TIMING:
        txsched_on_timing(&l->sched, m.u.timing.interval_0p1us, m.u.timing.offset_0p1us);
        l->last_offset_0p1us = m.u.timing.offset_0p1us;
        push(l, EV_TIMING, (int32_t)m.u.timing.interval_0p1us, m.u.timing.offset_0p1us, 0, 0, 0, 0, NULL);
        break;
    case CRSF_MSG_FLIGHT_MODE:
        safety_fc_flight_mode(&l->safety, m.u.flight_mode.mode, l->now_ns);
        if (strcmp(l->flight_mode, m.u.flight_mode.mode) != 0) {
            snprintf(l->flight_mode, sizeof l->flight_mode, "%s", m.u.flight_mode.mode);
            mailbox_put_flight_mode(l->mb, l->flight_mode);
            push(l, EV_FLIGHT_MODE, 0, 0, 0, 0, 0, 0, l->flight_mode);
        }
        break;
    case CRSF_MSG_LINK_STATS:
        mailbox_put_link(l->mb, &m.u.link);
        break;
    case CRSF_MSG_BATTERY:
        mailbox_put_battery(l->mb, &m.u.battery);
        break;
    case CRSF_MSG_DEVICE_INFO:
        mailbox_put_device(l->mb, &m.u.device);
        push(l, EV_DEVICE, m.u.device.origin, m.u.device.sw_major, m.u.device.sw_minor,
             m.u.device.sw_patch, 0, 0, m.u.device.name);
        break;
    default:
        break;
    }
}

static void serial_lost(rtloop_t *l)
{
    close(l->fd);
    l->fd = -1;
    l->last_open_attempt_ns = l->now_ns;
    push(l, EV_SERIAL, 0, 0, 0, 0, 0, 0, NULL);
}

/* Model select loads the ELRS model slot (and starts its timing frames); the ping
 * makes the module report its name and firmware version for the event log. */
static void send_hello(rtloop_t *l)
{
    uint8_t buf[16];
    size_t n = crsf_build_model_select(buf, sizeof buf, (uint8_t)l->cfg->model_id);
    if (write(l->fd, buf, n) < 0 && errno != EAGAIN) {
        serial_lost(l);
        return;
    }
    n = crsf_build_ping(buf, sizeof buf);
    if (write(l->fd, buf, n) < 0 && errno != EAGAIN) {
        serial_lost(l);
        return;
    }
    l->last_hello_ns = l->now_ns;
}

static void try_open(rtloop_t *l)
{
    if (l->now_ns - l->last_open_attempt_ns < REOPEN_INTERVAL_NS)
        return;
    l->last_open_attempt_ns = l->now_ns;
    int fd = serial_open(l->cfg->serial_device, l->cfg->baud);
    if (fd < 0)
        return;
    l->fd = fd;
    l->last_rx_ns = l->now_ns;
    crsf_deframer_init(&l->deframer);
    push(l, EV_SERIAL, 1, 0, 0, 0, 0, 0, NULL);
    send_hello(l);
}

static void read_telemetry(rtloop_t *l)
{
    uint8_t buf[256];
    for (int i = 0; i < 4 && l->fd >= 0; i++) {   /* bounded: never spin in the RT loop */
        ssize_t n = read(l->fd, buf, sizeof buf);
        if (n > 0) {
            crsf_deframer_feed(&l->deframer, buf, (size_t)n, on_frame, l);
            continue;
        }
        if (n < 0 && errno != EAGAIN && errno != EINTR)
            serial_lost(l);
        break;                                    /* 0 = nothing waiting */
    }
}

static void publish(rtloop_t *l, const uint16_t ch[CRSF_NUM_CHANNELS])
{
    const safety_t *s = &l->safety;
    int32_t age = cmd_age_ms(l);
    ipc_status_t st = {
        .state = (uint8_t)s->state,
        .fs_reason = (uint8_t)s->fs_reason,
        .fc_arm = (uint8_t)s->fc_arm,
        .serial_ok = l->fd >= 0,
        .session = s->session,
        .last_seq = s->last_seq,
        .cmd_age_ms = age < 0 ? IPC_NO_CMD_AGE : (uint32_t)age,
        .frames_sent = l->frames_sent,
        .tx_errors = l->tx_errors,
        .rx_frames = l->deframer.frames,
        .rx_crc_errors = l->deframer.crc_errors,
        .period_us = (uint32_t)(l->sched.period_ns / NS_PER_US),
        .offset_0p1us = l->last_offset_0p1us,
        .timing_frames = l->sched.timing_frames,
        .wake_late_max_us = (uint32_t)(l->late_max_ns / NS_PER_US),
    };
    memcpy(st.channels, ch, sizeof st.channels);
    mailbox_put_status(l->mb, &st);
    l->late_max_ns = 0;
}

static void tick(rtloop_t *l, int64_t deadline)
{
    l->now_ns = mono_ns();
    if (l->now_ns - deadline > l->late_max_ns)
        l->late_max_ns = l->now_ns - deadline;

    core_cmd_t cmds[MB_CMD_CAP];
    size_t n = mailbox_take_cmds(l->mb, cmds, MB_CMD_CAP);
    for (size_t i = 0; i < n; i++)
        apply(l, &cmds[i]);

    safety_state_t before = l->safety.state;
    uint32_t session = l->safety.session;
    int32_t age = cmd_age_ms(l);
    safety_tick(&l->safety, l->now_ns);
    if (l->safety.state != before)
        push(l, EV_STATE, (int32_t)before, (int32_t)l->safety.state, (int32_t)l->safety.fs_reason, 0,
             session, age, NULL);

    if (l->fd < 0)
        try_open(l);

    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    chmap_build(l->cfg, &l->safety.out, ch);
    crsf_build_rc_frame(frame, ch);

    timing_sample_t ts = { .deadline_ns = deadline, .wake_ns = l->now_ns, .period_ns = l->sched.period_ns };
    ts.write_start_ns = mono_ns();
    ts.write_end_ns = ts.write_start_ns;
    if (l->fd >= 0) {
        ssize_t w = write(l->fd, frame, sizeof frame);
        ts.write_end_ns = mono_ns();
        if (w == (ssize_t)sizeof frame)
            l->frames_sent++;
        else if (w >= 0 || errno == EAGAIN || errno == EINTR)
            l->tx_errors++;                      /* frame dropped, port still fine */
        else {
            l->tx_errors++;
            serial_lost(l);                      /* EIO/ENODEV: module unplugged */
        }
    }
    if (l->fd >= 0)
        read_telemetry(l);
    if (l->fd >= 0 && l->now_ns - l->last_rx_ns > MODULE_SILENT_NS &&
        l->now_ns - l->last_hello_ns > MODULE_SILENT_NS)
        send_hello(l);                           /* module rebooted or never answered */

    publish(l, ch);
    txsched_advance(&l->sched, mono_ns());
    ts.shift_ns = l->sched.last_shift_ns;
    if (l->cfg->timing_log[0] != '\0')
        mailbox_push_timing(l->mb, &ts);
}

void rtloop_init(rtloop_t *l, const config_t *cfg, mailbox_t *mb, atomic_bool *stop)
{
    memset(l, 0, sizeof *l);
    l->cfg = cfg;
    l->mb = mb;
    l->stop = stop;
    l->fd = -1;
    l->last_open_attempt_ns = INT64_MIN / 2;
    safety_init(&l->safety, (int64_t)cfg->cmd_timeout_ms * NS_PER_MS,
                (int64_t)cfg->fc_armed_fresh_ms * NS_PER_MS, (uint16_t)cfg->throttle_arm_max);
    crsf_deframer_init(&l->deframer);
}

void *rtloop_run(void *arg)
{
    rtloop_t *l = arg;
    rt_prefault_stack();
    l->now_ns = mono_ns();
    txsched_init(&l->sched, l->now_ns, (int64_t)l->cfg->default_period_us * NS_PER_US,
                 (int64_t)l->cfg->sync_margin_us * NS_PER_US);
    while (!atomic_load(l->stop)) {
        int64_t deadline = l->sched.next_ns;
        struct timespec ts = ns_to_timespec(deadline);
        while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL) == EINTR)
            ;
        tick(l, deadline);
    }
    /* Stop sending without a final frame: the module and Betaflight then run their own
     * link-loss handling, which is safer than forcing a disarm in flight. */
    if (l->fd >= 0)
        close(l->fd);
    return NULL;
}
