/* mailbox.h - the only state shared by the frame loop (real-time thread) and the IPC
 * thread. One priority-inheritance mutex guards it and is only held for short copies,
 * so the frame loop never waits on socket or file I/O. */
#ifndef MAILBOX_H
#define MAILBOX_H

#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include "crsf_telem.h"
#include "ipc_proto.h"
#include "safety.h"

#define MB_CMD_CAP    64
#define MB_EVENT_CAP  256
#define MB_TIMING_CAP 2048

typedef enum {
    CMD_SESSION = 1,
    CMD_CONTROL,
    CMD_ARM,
    CMD_DISARM,
    CMD_ACK,
    CMD_PILOT_LOST,
    CMD_FAILSAFE,
    CMD_GATEWAY_LOST,
} cmd_kind_t;

typedef struct {
    cmd_kind_t kind;
    uint32_t session;
    uint32_t seq;          /* CMD_CONTROL only */
    stick_cmd_t sticks;    /* CMD_CONTROL only */
} core_cmd_t;

typedef enum {
    EV_STATE = 1,    /* a = from, b = to, c = reason; session, cmd_age_ms */
    EV_REFUSED,      /* a = CMD_ARM or CMD_ACK, b = refuse_t; session */
    EV_FLIGHT_MODE,  /* text = mode reported by the flight controller */
    EV_SERIAL,       /* a = 1 opened, 0 lost */
    EV_DEVICE,       /* text = name; a = origin, b.c.d = firmware version */
    EV_TIMING,       /* a = interval (0.1 us), b = offset (0.1 us) */
    EV_GATEWAY,      /* a = 1 connected, 0 disconnected */
    EV_START,        /* text = version */
} event_kind_t;

typedef struct {
    event_kind_t kind;
    int64_t t_ns;          /* CLOCK_MONOTONIC */
    int32_t a, b, c, d;
    uint32_t session;
    int32_t cmd_age_ms;    /* -1 = no command received yet */
    char text[32];
} core_event_t;

typedef struct {
    int64_t deadline_ns;
    int64_t wake_ns;
    int64_t write_start_ns;
    int64_t write_end_ns;
    int64_t period_ns;
    int64_t shift_ns;
} timing_sample_t;

#define MB_DIRTY_LINK    1u
#define MB_DIRTY_BATTERY 2u
#define MB_DIRTY_FMODE   4u
#define MB_DIRTY_DEVICE  8u

typedef struct {
    pthread_mutex_t mu;
    core_cmd_t cmds[MB_CMD_CAP];
    unsigned cmd_r, cmd_w;          /* free-running counters: count = w - r */
    uint32_t cmd_dropped;
    core_event_t events[MB_EVENT_CAP];
    unsigned ev_r, ev_w;
    uint32_t ev_dropped;
    timing_sample_t timing[MB_TIMING_CAP];
    unsigned tm_r, tm_w;
    uint32_t tm_dropped;
    ipc_status_t status;
    crsf_link_stats_t link;
    crsf_battery_t battery;
    char flight_mode[16];
    crsf_device_info_t device;
    unsigned dirty;
} mailbox_t;

int mailbox_init(mailbox_t *m);
void mailbox_destroy(mailbox_t *m);

/* IPC thread -> frame loop. A CONTROL right behind a CONTROL of the same session replaces
 * it (order with other commands is kept). The last slot is reserved for GATEWAY_LOST, so
 * losing the gateway is always delivered. Returns false (and counts a drop) if full. */
bool mailbox_push_cmd(mailbox_t *m, const core_cmd_t *c);
size_t mailbox_take_cmds(mailbox_t *m, core_cmd_t *out, size_t max);

/* Frame loop -> IPC thread. Full queues drop the new item and count it. */
void mailbox_push_event(mailbox_t *m, const core_event_t *e);
size_t mailbox_take_events(mailbox_t *m, core_event_t *out, size_t max);
void mailbox_push_timing(mailbox_t *m, const timing_sample_t *t);
size_t mailbox_take_timing(mailbox_t *m, timing_sample_t *out, size_t max);

/* wake_late_max_us accumulates (max) until mailbox_take_status() resets it. */
void mailbox_put_status(mailbox_t *m, const ipc_status_t *s);
void mailbox_take_status(mailbox_t *m, ipc_status_t *out);

void mailbox_put_link(mailbox_t *m, const crsf_link_stats_t *l);
void mailbox_put_battery(mailbox_t *m, const crsf_battery_t *b);
void mailbox_put_flight_mode(mailbox_t *m, const char *mode);
void mailbox_put_device(mailbox_t *m, const crsf_device_info_t *d);
/* Copies the telemetry that changed since the last call; returns those MB_DIRTY_* bits. */
unsigned mailbox_take_telemetry(mailbox_t *m, crsf_link_stats_t *l, crsf_battery_t *b,
                                char fm[16], crsf_device_info_t *d);

#endif
