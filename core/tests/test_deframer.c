#include "check.h"
#include "crsf_deframer.h"

static const uint8_t PING[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
static const uint8_t FLIGHT_MODE[] = { 0xEA, 0x08, 0x21, 0x41, 0x43, 0x52, 0x4F, 0x2A, 0x00, 0x14 };

typedef struct {
    int count;
    size_t lens[8];
    uint8_t first_types[8];
} seen_t;

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    seen_t *s = user;
    if (s->count < 8) {
        s->lens[s->count] = len;
        s->first_types[s->count] = frame[2];
    }
    s->count++;
}

static void test_single_frame(void)
{
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK_EQ_INT(s.lens[0], sizeof PING);
    CHECK_EQ_INT(d.frames, 1);
}

static void test_frame_split_across_reads(void)
{
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    for (size_t i = 0; i < sizeof FLIGHT_MODE; i++)
        crsf_deframer_feed(&d, FLIGHT_MODE + i, 1, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK_EQ_INT(s.first_types[0], 0x21);
}

static void test_garbage_before_and_between_frames(void)
{
    uint8_t stream[64];
    size_t n = 0;
    stream[n++] = 0x00;
    stream[n++] = 0x13;
    memcpy(stream + n, PING, sizeof PING); n += sizeof PING;
    stream[n++] = 0x55;
    memcpy(stream + n, FLIGHT_MODE, sizeof FLIGHT_MODE); n += sizeof FLIGHT_MODE;

    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, stream, n, on_frame, &s);
    CHECK_EQ_INT(s.count, 2);
    CHECK_EQ_INT(s.first_types[0], 0x28);
    CHECK_EQ_INT(s.first_types[1], 0x21);
    CHECK_EQ_INT(d.dropped_bytes, 3);
}

static void test_bad_crc_is_rejected_and_stream_recovers(void)
{
    uint8_t stream[32];
    memcpy(stream, PING, sizeof PING);
    stream[5] ^= 0xFF;                               /* corrupt CRC */
    memcpy(stream + sizeof PING, PING, sizeof PING); /* followed by a good frame */

    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, stream, 2 * sizeof PING, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK_EQ_INT(d.crc_errors, 1);
}

static void test_impossible_length_is_skipped(void)
{
    static const uint8_t bad[] = { 0xEA, 0xFF, 0xEA, 0x01 };
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, bad, sizeof bad, on_frame, &s);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    CHECK_EQ_INT(s.count, 1);
    CHECK(d.dropped_bytes >= 3);
}

static void test_long_noise_never_overflows(void)
{
    uint8_t noise[4096];
    for (size_t i = 0; i < sizeof noise; i++)
        noise[i] = (uint8_t)(i * 37u + 11u);         /* includes many fake start bytes */
    crsf_deframer_t d;
    seen_t s = { 0 };
    crsf_deframer_init(&d);
    crsf_deframer_feed(&d, noise, sizeof noise, on_frame, &s);
    CHECK(d.len < CRSF_FRAME_MAX);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    crsf_deframer_feed(&d, PING, sizeof PING, on_frame, &s);
    CHECK(s.count >= 1);                             /* recovers once noise stops */
}

int main(void)
{
    RUN(test_single_frame);
    RUN(test_frame_split_across_reads);
    RUN(test_garbage_before_and_between_frames);
    RUN(test_bad_crc_is_rejected_and_stream_recovers);
    RUN(test_impossible_length_is_skipped);
    RUN(test_long_noise_never_overflows);
    return CHECK_EXIT();
}
