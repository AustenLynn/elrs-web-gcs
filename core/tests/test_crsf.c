#include "check.h"
#include "crsf.h"

/* Golden frames were produced by an independent Python implementation and, for the two
 * RC frames, also by PackChannels() from the kaack/elrs-joystick-control Go reference. */
static const uint8_t RC_CENTER[CRSF_RC_FRAME_LEN] = {
    0xEE, 0x18, 0x16, 0xE0, 0x03, 0x1F, 0xF8, 0xC0, 0x07, 0x3E, 0xF0, 0x81, 0x0F,
    0x7C, 0xE0, 0x03, 0x1F, 0xF8, 0xC0, 0x07, 0x3E, 0xF0, 0x81, 0x0F, 0x7C, 0xAD,
};
static const uint8_t RC_RAMP[CRSF_RC_FRAME_LEN] = {
    0xEE, 0x18, 0x16, 0xAC, 0xC8, 0x88, 0x61, 0xE6, 0x03, 0xA6, 0x66, 0xE9, 0xEC,
    0x74, 0x14, 0x0C, 0xA4, 0x3B, 0xB7, 0x8A, 0xDC, 0x1A, 0x8B, 0xFA, 0xE1, 0xE3,
};

static void ramp(uint16_t ch[CRSF_NUM_CHANNELS])
{
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = (uint16_t)(172 + i * 109);
}

static void test_us_to_ch_reference_points(void)
{
    CHECK_EQ_INT(crsf_us_to_ch(1500), 992);
    CHECK_EQ_INT(crsf_us_to_ch(1000), 192);
    CHECK_EQ_INT(crsf_us_to_ch(2000), 1792);
    CHECK_EQ_INT(crsf_us_to_ch(1001), 194);   /* 193.6 rounds up */
    CHECK_EQ_INT(crsf_us_to_ch(988), 173);    /* 172.8 rounds up */
}

static void test_us_to_ch_clamps(void)
{
    CHECK_EQ_INT(crsf_us_to_ch(500), CRSF_CH_MIN);
    CHECK_EQ_INT(crsf_us_to_ch(2500), CRSF_CH_MAX);
}

static void test_ch_to_us_reference_points(void)
{
    CHECK_EQ_INT(crsf_ch_to_us(992), 1500);
    CHECK_EQ_INT(crsf_ch_to_us(192), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(1792), 2000);
}

static void test_us_round_trip(void)
{
    for (int us = 1000; us <= 2000; us++)
        CHECK_EQ_INT(crsf_ch_to_us(crsf_us_to_ch(us)), us);
}

static void test_rc_frame_center_matches_golden(void)
{
    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = CRSF_CH_MID;
    crsf_build_rc_frame(frame, ch);
    CHECK_MEM(frame, RC_CENTER, sizeof RC_CENTER);
}

static void test_rc_frame_ramp_matches_golden(void)
{
    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    ramp(ch);
    crsf_build_rc_frame(frame, ch);
    CHECK_MEM(frame, RC_RAMP, sizeof RC_RAMP);
}

static void test_unpack_inverts_pack(void)
{
    uint16_t in[CRSF_NUM_CHANNELS], out[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    ramp(in);
    crsf_build_rc_frame(frame, in);
    crsf_unpack_channels(frame + 3, out);
    CHECK_MEM(in, out, sizeof in);
}

static void test_ping_frame(void)
{
    static const uint8_t expected[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
    uint8_t frame[8];
    CHECK_EQ_INT(crsf_build_ping(frame, sizeof frame), sizeof expected);
    CHECK_MEM(frame, expected, sizeof expected);
    CHECK_EQ_INT(crsf_build_ping(frame, 5), 0);
}

static void test_model_select_frame(void)
{
    static const uint8_t expected[] = { 0xC8, 0x08, 0x32, 0xEE, 0xEA, 0x10, 0x05, 0x00, 0xDC, 0x4D };
    uint8_t frame[16];
    CHECK_EQ_INT(crsf_build_model_select(frame, sizeof frame, 0), sizeof expected);
    CHECK_MEM(frame, expected, sizeof expected);
    CHECK_EQ_INT(crsf_build_model_select(frame, 9, 0), 0);
}

int main(void)
{
    RUN(test_us_to_ch_reference_points);
    RUN(test_us_to_ch_clamps);
    RUN(test_ch_to_us_reference_points);
    RUN(test_us_round_trip);
    RUN(test_rc_frame_center_matches_golden);
    RUN(test_rc_frame_ramp_matches_golden);
    RUN(test_unpack_inverts_pack);
    RUN(test_ping_frame);
    RUN(test_model_select_frame);
    return CHECK_EXIT();
}
