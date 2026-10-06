#include "check.h"
#include "ipc_proto.h"

/* Shared with gateway/test/ipc.test.js: both implementations must produce/accept these. */
static const uint8_t CONTROL_GOLDEN[] = {
    0x12, 0x00, 0x02, 0x04, 0x03, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00,
    0x18, 0xFC, 0xFA, 0x00, 0x00, 0x00, 0xE8, 0x03, 0x02,
};

static ipc_status_t sample_status(void)
{
    ipc_status_t s = {
        .state = 2, .fs_reason = 1, .fc_arm = 2, .serial_ok = 1,
        .session = 0x01020304, .last_seq = 99, .cmd_age_ms = 301,
        .frames_sent = 1000, .tx_errors = 2, .rx_frames = 50, .rx_crc_errors = 1,
        .period_us = 4000, .offset_0p1us = -1234, .timing_frames = 7, .wake_late_max_us = 85,
    };
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        s.channels[i] = (uint16_t)(172 + i);
    return s;
}

typedef struct {
    int count;
    uint8_t type;
    uint8_t payload[IPC_MAX_MSG];
    size_t plen;
} got_t;

static void on_msg(uint8_t type, const uint8_t *payload, size_t plen, void *user)
{
    got_t *g = user;
    g->count++;
    g->type = type;
    memcpy(g->payload, payload, plen);
    g->plen = plen;
}

static void test_control_golden_bytes(void)
{
    ipc_control_t c = { .session = 0x01020304, .seq = 5,
                        .sticks = { .roll = -1000, .pitch = 250, .yaw = 0, .throttle = 1000, .mode = 2 } };
    uint8_t buf[64];
    CHECK_EQ_INT(ipc_encode_control(buf, sizeof buf, &c), sizeof CONTROL_GOLDEN);
    CHECK_MEM(buf, CONTROL_GOLDEN, sizeof CONTROL_GOLDEN);

    ipc_control_t d;
    CHECK_EQ_INT(ipc_decode_control(CONTROL_GOLDEN + 3, sizeof CONTROL_GOLDEN - 3, &d), 0);
    CHECK_EQ_INT(d.session, 0x01020304);
    CHECK_EQ_INT(d.seq, 5);
    CHECK_EQ_INT(d.sticks.roll, -1000);
    CHECK_EQ_INT(d.sticks.pitch, 250);
    CHECK_EQ_INT(d.sticks.throttle, 1000);
    CHECK_EQ_INT(d.sticks.mode, 2);
}

static void test_status_round_trip_and_layout(void)
{
    ipc_status_t s = sample_status(), d;
    uint8_t buf[128];
    size_t n = ipc_encode_status(buf, sizeof buf, &s);
    CHECK_EQ_INT(n, 3 + IPC_STATUS_LEN);
    CHECK_EQ_INT(buf[0], IPC_STATUS_LEN + 1);
    CHECK_EQ_INT(buf[2], IPC_STATUS);
    CHECK_EQ_INT(buf[3], 2);                       /* state first */
    CHECK_EQ_INT(buf[3 + 12], 0x2D);               /* cmd_age_ms = 301 = 0x012D, LE */
    CHECK_EQ_INT(buf[3 + 48], 172);                /* channels start at payload offset 48 */
    CHECK_EQ_INT(ipc_decode_status(buf + 3, n - 3, &d), 0);
    CHECK_MEM(&s, &d, sizeof s);
}

static void test_small_messages(void)
{
    uint8_t buf[64];
    uint32_t session = 0;
    size_t n = ipc_encode_session_msg(buf, sizeof buf, IPC_ARM, 77);
    CHECK_EQ_INT(n, 7);
    CHECK_EQ_INT(buf[2], IPC_ARM);
    CHECK_EQ_INT(ipc_decode_session_msg(buf + 3, 4, &session), 0);
    CHECK_EQ_INT(session, 77);
    CHECK_EQ_INT(ipc_decode_session_msg(buf + 3, 3, &session), -1);

    CHECK_EQ_INT(ipc_encode_flight_mode(buf, sizeof buf, "ACRO*"), 3 + 1 + 5);
    CHECK_EQ_INT(buf[3], 5);
    CHECK_EQ_INT(ipc_encode_flight_mode(buf, sizeof buf, "THIS-IS-A-VERY-LONG-MODE"), 3 + 1 + 15);
    CHECK_EQ_INT(ipc_encode_event(buf, sizeof buf, IPC_EVENT_ARM_REFUSED, REFUSE_THROTTLE_HIGH, 9), 9);
    CHECK_EQ_INT(ipc_encode_session_msg(buf, 6, IPC_ARM, 1), 0);   /* too small */
}

static void test_reader_handles_split_and_batched_messages(void)
{
    uint8_t stream[64];
    size_t n = ipc_encode_session_msg(stream, sizeof stream, IPC_SESSION, 5);
    memcpy(stream + n, CONTROL_GOLDEN, sizeof CONTROL_GOLDEN);
    n += sizeof CONTROL_GOLDEN;

    ipc_reader_t r;
    got_t g = { 0 };
    ipc_reader_init(&r);
    for (size_t i = 0; i < n; i++)
        CHECK_EQ_INT(ipc_reader_feed(&r, stream + i, 1, on_msg, &g), 0);
    CHECK_EQ_INT(g.count, 2);
    CHECK_EQ_INT(g.type, IPC_CONTROL);
    CHECK_EQ_INT(g.plen, 17);

    got_t h = { 0 };
    ipc_reader_init(&r);
    CHECK_EQ_INT(ipc_reader_feed(&r, stream, n, on_msg, &h), 0);
    CHECK_EQ_INT(h.count, 2);
}

static void test_reader_rejects_bad_lengths(void)
{
    static const uint8_t zero[] = { 0x00, 0x00 };
    static const uint8_t huge[] = { 0x00, 0x01 };   /* 256 > IPC_MAX_MSG */
    ipc_reader_t r;
    got_t g = { 0 };
    ipc_reader_init(&r);
    CHECK_EQ_INT(ipc_reader_feed(&r, zero, sizeof zero, on_msg, &g), -1);
    ipc_reader_init(&r);
    CHECK_EQ_INT(ipc_reader_feed(&r, huge, sizeof huge, on_msg, &g), -1);
    CHECK_EQ_INT(g.count, 0);
}

int main(void)
{
    RUN(test_control_golden_bytes);
    RUN(test_status_round_trip_and_layout);
    RUN(test_small_messages);
    RUN(test_reader_handles_split_and_batched_messages);
    RUN(test_reader_rejects_bad_lengths);
    return CHECK_EXIT();
}
