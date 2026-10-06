/* crsf_deframer.h - split a serial byte stream into CRC-checked CRSF frames. */
#ifndef CRSF_DEFRAMER_H
#define CRSF_DEFRAMER_H

#include <stddef.h>
#include <stdint.h>
#include "crsf.h"

/* Called once per valid frame. `frame` is only valid during the call; do not call
 * crsf_deframer_feed() from inside the callback. */
typedef void (*crsf_frame_cb)(const uint8_t *frame, size_t len, void *user);

typedef struct {
    uint8_t buf[CRSF_FRAME_MAX];
    size_t len;
    uint32_t frames;         /* valid frames delivered */
    uint32_t crc_errors;     /* candidate frames rejected by CRC */
    uint32_t dropped_bytes;  /* bytes skipped while searching for a frame start */
} crsf_deframer_t;

void crsf_deframer_init(crsf_deframer_t *d);
void crsf_deframer_feed(crsf_deframer_t *d, const uint8_t *data, size_t n,
                        crsf_frame_cb cb, void *user);

#endif
