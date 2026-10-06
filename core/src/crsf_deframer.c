#include "crsf_deframer.h"
#include "crc8.h"
#include <string.h>

static int is_frame_start(uint8_t b)
{
    return b == CRSF_ADDR_HANDSET || b == CRSF_ADDR_MODULE || b == CRSF_ADDR_SYNC;
}

static void drop_front(crsf_deframer_t *d, size_t n)
{
    memmove(d->buf, d->buf + n, d->len - n);
    d->len -= n;
}

void crsf_deframer_init(crsf_deframer_t *d)
{
    memset(d, 0, sizeof *d);
}

void crsf_deframer_feed(crsf_deframer_t *d, const uint8_t *data, size_t n,
                        crsf_frame_cb cb, void *user)
{
    for (size_t i = 0; i < n; i++) {
        /* Invariant: d->len < CRSF_FRAME_MAX here, because a buffer holding a whole
         * frame is always consumed below before the next byte is appended. */
        d->buf[d->len++] = data[i];
        for (;;) {
            if (d->len == 0)
                break;
            if (!is_frame_start(d->buf[0])) {
                drop_front(d, 1);
                d->dropped_bytes++;
                continue;
            }
            if (d->len < 2)
                break;
            size_t flen = d->buf[1];              /* bytes after the length byte */
            if (flen < 2 || flen > CRSF_FRAME_MAX - 2) {
                drop_front(d, 1);
                d->dropped_bytes++;
                continue;
            }
            size_t total = flen + 2;
            if (d->len < total)
                break;
            if (crc8_d5(d->buf + 2, flen - 1) != d->buf[total - 1]) {
                drop_front(d, 1);                 /* resync on the next start byte */
                d->crc_errors++;
                continue;
            }
            d->frames++;
            cb(d->buf, total, user);
            drop_front(d, total);
        }
    }
}
