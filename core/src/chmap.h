/* chmap.h - turn the safety layer's outputs into the 16 CRSF channel values. */
#ifndef CHMAP_H
#define CHMAP_H

#include <stdbool.h>
#include <stdint.h>
#include "config.h"
#include "crsf.h"

typedef struct {
    int16_t roll, pitch, yaw;  /* -1000..1000, 0 = centred */
    uint16_t throttle;         /* 0..1000 */
    uint8_t mode;              /* flight-mode switch position 0..2 */
    bool arm;                  /* ARM switch high */
    bool failsafe;             /* FAILSAFE switch high */
} rc_outputs_t;

/* Sticks map linearly onto stick_min_us..stick_max_us, switches onto min/max (mode
 * position 1 = centre). Channels without a function stay at stick_min_us (low). */
void chmap_build(const config_t *cfg, const rc_outputs_t *o, uint16_t ch[CRSF_NUM_CHANNELS]);

#endif
