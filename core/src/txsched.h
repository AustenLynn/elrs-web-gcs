/* txsched.h - when to send the next RC frame, locked to the TX module's timing frames.
 *
 * ELRS sends a timing frame about every 200 ms with the interval it wants and an
 * offset: how far (in 0.1 us) our frames should move later (+) or earlier (-) to
 * arrive just before its radio packet. We adopt the interval and apply each offset
 * once, minus a margin that leaves headroom for USB latency (same idea as EdgeTX). */
#ifndef TXSCHED_H
#define TXSCHED_H

#include <stdint.h>
#include "timeutil.h"

#define TXSCHED_MIN_PERIOD_NS (500 * NS_PER_US)
#define TXSCHED_MAX_PERIOD_NS (50 * NS_PER_MS)

typedef struct {
    int64_t period_ns;
    int64_t next_ns;           /* absolute CLOCK_MONOTONIC deadline of the next frame */
    int64_t margin_ns;
    int64_t pending_shift_ns;  /* one-shot phase correction for the next period */
    int64_t last_shift_ns;     /* shift applied by the last txsched_advance() */
    uint32_t timing_frames;
} txsched_t;

void txsched_init(txsched_t *s, int64_t now_ns, int64_t period_ns, int64_t margin_ns);
void txsched_on_timing(txsched_t *s, uint32_t interval_0p1us, int32_t offset_0p1us);
/* Call after sending the frame due at s->next_ns. Returns the new deadline. If we
 * fell more than a period behind, missed slots are skipped (no burst of frames). */
int64_t txsched_advance(txsched_t *s, int64_t now_ns);

#endif
