#include "check.h"
#include "mailbox.h"

static void test_commands_are_fifo_and_bounded(void)
{
    /* Discrete commands fill MB_CMD_CAP - 1 slots; the last slot is kept for GATEWAY_LOST. */
    mailbox_t m;
    CHECK_EQ_INT(mailbox_init(&m), 0);
    core_cmd_t c = { .kind = CMD_ARM };
    for (unsigned i = 0; i < MB_CMD_CAP - 1; i++) {
        c.session = i;
        CHECK(mailbox_push_cmd(&m, &c));
    }
    c.session = 999;
    CHECK(!mailbox_push_cmd(&m, &c));              /* full: newest is dropped */
    CHECK_EQ_INT(m.cmd_dropped, 1);

    core_cmd_t out[MB_CMD_CAP];
    CHECK_EQ_INT(mailbox_take_cmds(&m, out, 10), 10);
    CHECK_EQ_INT(out[0].session, 0);
    CHECK_EQ_INT(out[9].session, 9);
    CHECK_EQ_INT(mailbox_take_cmds(&m, out, MB_CMD_CAP), MB_CMD_CAP - 11);
    CHECK_EQ_INT(out[0].session, 10);
    CHECK_EQ_INT(mailbox_take_cmds(&m, out, MB_CMD_CAP), 0);
    mailbox_destroy(&m);
}

static void test_control_bursts_keep_only_the_latest(void)
{
    /* A gateway flushing a backlog must not fill the queue: back-to-back CONTROLs of the
     * same session collapse into the newest one. */
    mailbox_t m;
    mailbox_init(&m);
    core_cmd_t c = { .kind = CMD_CONTROL, .session = 7 };
    for (unsigned i = 1; i <= 2000; i++) {
        c.seq = i;
        CHECK(mailbox_push_cmd(&m, &c));
    }
    core_cmd_t out[MB_CMD_CAP];
    CHECK_EQ_INT(mailbox_take_cmds(&m, out, MB_CMD_CAP), 1);
    CHECK_EQ_INT(out[0].seq, 2000);
    CHECK_EQ_INT(m.cmd_dropped, 0);
    mailbox_destroy(&m);
}

static void test_controls_never_jump_over_other_commands(void)
{
    mailbox_t m;
    mailbox_init(&m);
    core_cmd_t ctl = { .kind = CMD_CONTROL, .session = 7, .seq = 1 };
    core_cmd_t arm = { .kind = CMD_ARM, .session = 7 };
    mailbox_push_cmd(&m, &ctl);
    mailbox_push_cmd(&m, &arm);
    ctl.seq = 2;
    mailbox_push_cmd(&m, &ctl);
    ctl.session = 8;                               /* another session: not merged */
    ctl.seq = 1;
    mailbox_push_cmd(&m, &ctl);
    core_cmd_t out[8];
    CHECK_EQ_INT(mailbox_take_cmds(&m, out, 8), 4);
    CHECK_EQ_INT(out[0].kind, CMD_CONTROL);
    CHECK_EQ_INT(out[1].kind, CMD_ARM);
    CHECK_EQ_INT(out[2].seq, 2);
    CHECK_EQ_INT(out[3].session, 8);
    mailbox_destroy(&m);
}

static void test_gateway_lost_always_fits(void)
{
    mailbox_t m;
    mailbox_init(&m);
    core_cmd_t c = { .kind = CMD_FAILSAFE };
    while (mailbox_push_cmd(&m, &c))
        ;
    core_cmd_t lost = { .kind = CMD_GATEWAY_LOST };
    CHECK(mailbox_push_cmd(&m, &lost));
    core_cmd_t out[MB_CMD_CAP];
    CHECK_EQ_INT(mailbox_take_cmds(&m, out, MB_CMD_CAP), MB_CMD_CAP);
    CHECK_EQ_INT(out[MB_CMD_CAP - 1].kind, CMD_GATEWAY_LOST);
    mailbox_destroy(&m);
}

static void test_rings_wrap_around(void)
{
    mailbox_t m;
    mailbox_init(&m);
    core_event_t e = { .kind = EV_TIMING }, out[4];
    for (int round = 0; round < 1000; round++) {
        e.a = round;
        mailbox_push_event(&m, &e);
        CHECK_EQ_INT(mailbox_take_events(&m, out, 4), 1);
        CHECK_EQ_INT(out[0].a, round);
    }
    CHECK_EQ_INT(m.ev_dropped, 0);
    mailbox_destroy(&m);
}

static void test_status_keeps_worst_lateness_until_read(void)
{
    mailbox_t m;
    mailbox_init(&m);
    ipc_status_t s = { .frames_sent = 1, .wake_late_max_us = 90 }, out;
    mailbox_put_status(&m, &s);
    s.frames_sent = 2;
    s.wake_late_max_us = 10;
    mailbox_put_status(&m, &s);
    mailbox_take_status(&m, &out);
    CHECK_EQ_INT(out.frames_sent, 2);
    CHECK_EQ_INT(out.wake_late_max_us, 90);
    mailbox_take_status(&m, &out);
    CHECK_EQ_INT(out.wake_late_max_us, 0);
    mailbox_destroy(&m);
}

static void test_telemetry_dirty_bits(void)
{
    mailbox_t m;
    mailbox_init(&m);
    crsf_link_stats_t l = { .up_lq = 99 }, lo;
    crsf_battery_t b, bo;
    crsf_device_info_t d, dout;
    char fm[16];
    memset(&b, 0, sizeof b);
    memset(&d, 0, sizeof d);
    mailbox_put_link(&m, &l);
    mailbox_put_flight_mode(&m, "ACRO*");
    CHECK_EQ_INT(mailbox_take_telemetry(&m, &lo, &bo, fm, &dout), MB_DIRTY_LINK | MB_DIRTY_FMODE);
    CHECK_EQ_INT(lo.up_lq, 99);
    CHECK_STR(fm, "ACRO*");
    CHECK_EQ_INT(mailbox_take_telemetry(&m, &lo, &bo, fm, &dout), 0);
    mailbox_put_battery(&m, &b);
    mailbox_put_device(&m, &d);
    CHECK_EQ_INT(mailbox_take_telemetry(&m, &lo, &bo, fm, &dout), MB_DIRTY_BATTERY | MB_DIRTY_DEVICE);
    mailbox_destroy(&m);
}

int main(void)
{
    RUN(test_commands_are_fifo_and_bounded);
    RUN(test_control_bursts_keep_only_the_latest);
    RUN(test_controls_never_jump_over_other_commands);
    RUN(test_gateway_lost_always_fits);
    RUN(test_rings_wrap_around);
    RUN(test_status_keeps_worst_lateness_until_read);
    RUN(test_telemetry_dirty_bits);
    return CHECK_EXIT();
}
