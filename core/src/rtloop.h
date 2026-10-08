/* rtloop.h - the frame loop. Owns the serial port, the safety state machine and the
 * scheduler; runs in its own real-time thread and talks to the rest of the program
 * only through the mailbox. One iteration ("tick") per RC frame:
 *   apply queued commands -> check timeouts -> send frame -> read telemetry -> publish. */
#ifndef RTLOOP_H
#define RTLOOP_H

#include <stdatomic.h>
#include "config.h"
#include "crsf_deframer.h"
#include "mailbox.h"
#include "safety.h"
#include "txsched.h"

typedef struct {
    const config_t *cfg;
    mailbox_t *mb;
    atomic_bool *stop;
    int fd;                        /* serial port, -1 while closed */
    safety_t safety;
    txsched_t sched;
    crsf_deframer_t deframer;
    int64_t now_ns;                /* wake-up time of the current tick */
    int64_t last_rx_ns;            /* last valid frame from the module */
    int64_t last_hello_ns;         /* last model-select + ping */
    bool module_identified;        /* the module answered a ping since the port opened */
    int64_t last_open_attempt_ns;
    uint32_t frames_sent;
    uint32_t tx_errors;
    int32_t last_offset_0p1us;
    int64_t late_max_ns;
    char flight_mode[16];
} rtloop_t;

void rtloop_init(rtloop_t *l, const config_t *cfg, mailbox_t *mb, atomic_bool *stop);
/* Thread entry point; `arg` is the rtloop_t. Returns when *stop becomes true. */
void *rtloop_run(void *arg);

#endif
