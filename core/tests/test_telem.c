#include "check.h"
#include "crsf_telem.h"

/* Golden frames from an independent Python implementation (see plan M1). */
static const uint8_t LINK[] = { 0xEA, 0x0C, 0x14, 0xBD, 0xBA, 0x64, 0x09, 0x01, 0x07, 0x03,
                                0xC9, 0x62, 0xFC, 0x8C };
static const uint8_t BATTERY[] = { 0xEA, 0x0A, 0x08, 0x00, 0xA8, 0x00, 0x2D, 0x00, 0x04, 0xD2,
                                   0x57, 0x96 };
static const uint8_t FLIGHT_MODE[] = { 0xEA, 0x08, 0x21, 0x41, 0x43, 0x52, 0x4F, 0x2A, 0x00, 0x14 };
static const uint8_t TIMING[] = { 0xEA, 0x0D, 0x3A, 0xEA, 0xEE, 0x10, 0x00, 0x00, 0x9C, 0x40,
                                  0xFF, 0xFF, 0xFB, 0x2E, 0xAA };
static const uint8_t DEVICE[] = { 0xEA, 0x1D, 0x29, 0xEA, 0xEE, 0x42, 0x45, 0x54, 0x41, 0x46,
                                  0x50, 0x56, 0x20, 0x31, 0x57, 0x00, 0x45, 0x4C, 0x52, 0x53,
                                  0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x05, 0x03, 0x15, 0x00,
                                  0x99 };

static void test_link_stats(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(LINK, sizeof LINK, &m), CRSF_MSG_LINK_STATS);
    CHECK_EQ_INT(m.u.link.up_rssi1, -67);
    CHECK_EQ_INT(m.u.link.up_rssi2, -70);
    CHECK_EQ_INT(m.u.link.up_lq, 100);
    CHECK_EQ_INT(m.u.link.up_snr, 9);
    CHECK_EQ_INT(m.u.link.antenna, 1);
    CHECK_EQ_INT(m.u.link.rf_mode, 7);
    CHECK_EQ_INT(m.u.link.tx_power_mw, 100);
    CHECK_EQ_INT(m.u.link.dn_rssi, -55);
    CHECK_EQ_INT(m.u.link.dn_lq, 98);
    CHECK_EQ_INT(m.u.link.dn_snr, -4);
}

static void test_battery(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(BATTERY, sizeof BATTERY, &m), CRSF_MSG_BATTERY);
    CHECK_EQ_INT(m.u.battery.voltage_dv, 168);
    CHECK_EQ_INT(m.u.battery.current_da, 45);
    CHECK_EQ_INT(m.u.battery.capacity_mah, 1234);
    CHECK_EQ_INT(m.u.battery.remaining_pct, 87);
}

static void test_flight_mode(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(FLIGHT_MODE, sizeof FLIGHT_MODE, &m), CRSF_MSG_FLIGHT_MODE);
    CHECK_STR(m.u.flight_mode.mode, "ACRO*");
}

static void test_timing(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(TIMING, sizeof TIMING, &m), CRSF_MSG_TIMING);
    CHECK_EQ_INT(m.u.timing.interval_0p1us, 40000);
    CHECK_EQ_INT(m.u.timing.offset_0p1us, -1234);
}

static void test_device_info(void)
{
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(DEVICE, sizeof DEVICE, &m), CRSF_MSG_DEVICE_INFO);
    CHECK_STR(m.u.device.name, "BETAFPV 1W");
    CHECK_EQ_INT(m.u.device.origin, 0xEE);
    CHECK_EQ_INT(m.u.device.serial, 0x454C5253);
    CHECK_EQ_INT(m.u.device.sw_major, 3);
    CHECK_EQ_INT(m.u.device.sw_minor, 5);
    CHECK_EQ_INT(m.u.device.sw_patch, 3);
    CHECK_EQ_INT(m.u.device.field_count, 21);
}

static void test_long_device_name_is_truncated(void)
{
    uint8_t f[80] = { 0xEA, 0, 0x29, 0xEA, 0xEE };
    size_t n = 5;
    for (int i = 0; i < 40; i++)
        f[n++] = (uint8_t)('A' + i % 26);
    f[n++] = 0;
    static const uint8_t tail[] = { 'E', 'L', 'R', 'S', 0, 0, 0, 0, 0, 3, 5, 3, 21, 0 };
    memcpy(f + n, tail, sizeof tail);
    n += sizeof tail;
    f[n++] = 0;                                       /* CRC (not checked here) */
    f[1] = (uint8_t)(n - 2);
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(f, n, &m), CRSF_MSG_DEVICE_INFO);
    CHECK_EQ_INT(strlen(m.u.device.name), sizeof m.u.device.name - 1);
    CHECK_EQ_INT(m.u.device.sw_minor, 5);
    CHECK_EQ_INT(m.u.device.serial, 0x454C5253);
}

static void test_rc_channels_round_trip(void)
{
    uint16_t ch[CRSF_NUM_CHANNELS];
    uint8_t frame[CRSF_RC_FRAME_LEN];
    crsf_msg_t m;
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = (uint16_t)(CRSF_CH_MIN + i);
    crsf_build_rc_frame(frame, ch);
    CHECK_EQ_INT(crsf_decode(frame, sizeof frame, &m), CRSF_MSG_RC_CHANNELS);
    CHECK_MEM(m.u.channels, ch, sizeof ch);
}

static void test_wrong_lengths_are_rejected(void)
{
    crsf_msg_t m;
    uint8_t shortened[sizeof LINK];
    memcpy(shortened, LINK, sizeof LINK);
    shortened[1] = 0x0B;                              /* claims one byte less than it has */
    CHECK_EQ_INT(crsf_decode(shortened, sizeof shortened, &m), CRSF_MSG_NONE);
    CHECK_EQ_INT(crsf_decode(LINK, 3, &m), CRSF_MSG_NONE);

    uint8_t no_nul[sizeof DEVICE];
    memcpy(no_nul, DEVICE, sizeof DEVICE);
    for (size_t i = 5; i < sizeof DEVICE - 1; i++)
        if (no_nul[i] == 0)
            no_nul[i] = 'x';                          /* name without terminator */
    CHECK_EQ_INT(crsf_decode(no_nul, sizeof no_nul, &m), CRSF_MSG_NONE);
}

static void test_flight_mode_is_truncated_safely(void)
{
    uint8_t frame[40] = { 0xEA, 0, 0x21 };
    size_t n = 3;
    for (int i = 0; i < 30; i++)
        frame[n++] = 'A';
    frame[n++] = 0x00;     /* CRC is not checked by crsf_decode */
    frame[1] = (uint8_t)(n - 2);
    crsf_msg_t m;
    CHECK_EQ_INT(crsf_decode(frame, n, &m), CRSF_MSG_FLIGHT_MODE);
    CHECK_EQ_INT(strlen(m.u.flight_mode.mode), sizeof m.u.flight_mode.mode - 1);
}

int main(void)
{
    RUN(test_link_stats);
    RUN(test_battery);
    RUN(test_flight_mode);
    RUN(test_timing);
    RUN(test_device_info);
    RUN(test_long_device_name_is_truncated);
    RUN(test_rc_channels_round_trip);
    RUN(test_wrong_lengths_are_rejected);
    RUN(test_flight_mode_is_truncated_safely);
    return CHECK_EXIT();
}
