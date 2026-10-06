#include "check.h"
#include "chmap.h"

static void test_neutral_outputs(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { 0 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(ch[0], 992);   /* roll centred */
    CHECK_EQ_INT(ch[1], 992);   /* pitch centred */
    CHECK_EQ_INT(ch[2], 192);   /* throttle 1000 us */
    CHECK_EQ_INT(ch[3], 992);   /* yaw centred */
    CHECK_EQ_INT(ch[4], 192);   /* arm low */
    CHECK_EQ_INT(ch[5], 192);   /* mode position 0 */
    CHECK_EQ_INT(ch[6], 192);   /* failsafe low */
    for (int i = 7; i < CRSF_NUM_CHANNELS; i++)
        CHECK_EQ_INT(ch[i], 192);
}

static void test_full_deflection_and_switches(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { .roll = 1000, .pitch = -1000, .yaw = 500, .throttle = 1000,
                       .mode = 1, .arm = true, .failsafe = true };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[0]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[1]), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[3]), 1750);
    CHECK_EQ_INT(crsf_ch_to_us(ch[2]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 1500);
    CHECK_EQ_INT(crsf_ch_to_us(ch[4]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[6]), 2000);
    o.mode = 2;
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);
}

static void test_out_of_range_inputs_are_clamped(void)
{
    config_t c;
    config_defaults(&c);
    rc_outputs_t o = { .roll = 30000, .pitch = -30000, .throttle = 5000, .mode = 9 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[0]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[1]), 1000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[2]), 2000);
    CHECK_EQ_INT(crsf_ch_to_us(ch[5]), 2000);
}

static void test_custom_channel_order(void)
{
    config_t c;
    config_defaults(&c);
    c.ch_throttle = 0;    /* TAER */
    c.ch_roll = 1;
    c.ch_pitch = 2;
    rc_outputs_t o = { .roll = 1000, .throttle = 0 };
    uint16_t ch[CRSF_NUM_CHANNELS];
    chmap_build(&c, &o, ch);
    CHECK_EQ_INT(crsf_ch_to_us(ch[0]), 1000);   /* throttle low on CH1 */
    CHECK_EQ_INT(crsf_ch_to_us(ch[1]), 2000);   /* roll right on CH2 */
}

int main(void)
{
    RUN(test_neutral_outputs);
    RUN(test_full_deflection_and_switches);
    RUN(test_out_of_range_inputs_are_clamped);
    RUN(test_custom_channel_order);
    return CHECK_EXIT();
}
