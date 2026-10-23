#include "check.h"
#include "safety.h"

#define MS 1000000LL
#define TIMEOUT (300 * MS)
#define FC_FRESH (3000 * MS)

static const stick_cmd_t LOW = { 0 };

static void setup(safety_t *s)
{
    safety_init(s, TIMEOUT, FC_FRESH, 50);
}

/* Session 7 with one fresh command at t=0 and armed. */
static void armed(safety_t *s)
{
    setup(s);
    safety_session_start(s, 7);
    CHECK(safety_control(s, 7, 1, &LOW, 0));
    CHECK_EQ_INT(safety_arm(s, 7, 0), REFUSE_NONE);
}

static void test_radio_link_loss_fails_safe_when_enabled(void)
{
    /* Aquila20: the drone disarms itself when it loses the radio link but never says so.
     * The core must follow (FAILSAFE rf_lost: ARM low) instead of showing ARMED and holding
     * ARM high over a disarmed drone. Commands keep arriving, so only the radio is stale. */
    safety_t s;
    armed(&s);
    safety_set_rf_timeout(&s, 1000 * MS);
    stick_cmd_t c = LOW;
    for (int t = 100; t <= 900; t += 100) {           /* link reports with LQ > 0 */
        safety_rf_link(&s, true, t * MS);
        CHECK(safety_control(&s, 7, (uint32_t)t, &c, t * MS));
        safety_tick(&s, t * MS);
    }
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    for (int t = 1000; t <= 1900; t += 100) {         /* reports stop (or say LQ 0) */
        safety_rf_link(&s, false, t * MS);
        CHECK(safety_control(&s, 7, (uint32_t)t, &c, t * MS));
        safety_tick(&s, t * MS);
    }
    CHECK_EQ_INT(s.state, SAFETY_ARMED);              /* 1000 ms since the last LQ > 0 */
    CHECK(safety_control(&s, 7, 2001, &c, 2000 * MS));
    safety_tick(&s, 2000 * MS);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_STR(safety_reason_name(s.fs_reason), "rf_lost");
}

static void test_radio_link_check_is_off_by_default(void)
{
    /* Betaflight runs its own RX-loss failsafe and reports it; the core does not add one. */
    safety_t s;
    armed(&s);
    stick_cmd_t c = LOW;
    for (int t = 100; t <= 3000; t += 100) {
        CHECK(safety_control(&s, 7, (uint32_t)t, &c, t * MS));
        safety_tick(&s, t * MS);
    }
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
}

static void test_arm_needs_a_live_radio_link_when_enabled(void)
{
    /* Flight test 2026-10-09: arming right after the TX module reconnected, before its radio
     * link to the drone was back, armed and failed safe (rf_lost) in the same tick. Arming
     * must be refused instead, with its own reason, and work once the link reports in. */
    safety_t s;
    setup(&s);
    safety_set_rf_timeout(&s, 1000 * MS);
    safety_session_start(&s, 7);
    CHECK(safety_control(&s, 7, 1, &LOW, 5000 * MS));
    CHECK_EQ_INT(safety_arm(&s, 7, 5000 * MS), REFUSE_RF_DOWN);  /* no link report ever */
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.arm);
    safety_rf_link(&s, true, 5100 * MS);
    CHECK(safety_control(&s, 7, 2, &LOW, 5200 * MS));
    CHECK_EQ_INT(safety_arm(&s, 7, 5200 * MS), REFUSE_NONE);
    safety_disarm(&s, 7);
    safety_rf_link(&s, false, 6000 * MS);                         /* LQ 0 does not count */
    CHECK(safety_control(&s, 7, 3, &LOW, 6200 * MS));
    CHECK_EQ_INT(safety_arm(&s, 7, 6200 * MS), REFUSE_RF_DOWN);  /* 1100 ms since LQ > 0 */
    CHECK_STR(safety_refuse_name(REFUSE_RF_DOWN), "rf_down");
}

static void test_arm_ignores_the_radio_link_by_default(void)
{
    /* Betaflight profile: no radio-link check, so no link report is needed to arm. */
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    CHECK(safety_control(&s, 7, 1, &LOW, 5000 * MS));
    CHECK_EQ_INT(safety_arm(&s, 7, 5000 * MS), REFUSE_NONE);
}

static void test_starts_disarmed_with_safe_outputs(void)
{
    safety_t s;
    setup(&s);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.arm);
    CHECK(!s.out.failsafe);
    CHECK_EQ_INT(s.out.throttle, 0);
}

static void test_commands_need_the_current_session(void)
{
    safety_t s;
    setup(&s);
    stick_cmd_t c = { .roll = 100 };
    CHECK(!safety_control(&s, 7, 1, &c, 0));          /* no session yet */
    safety_session_start(&s, 7);
    CHECK(!safety_control(&s, 8, 1, &c, 0));          /* other session */
    CHECK(safety_control(&s, 7, 1, &c, 0));
    CHECK_EQ_INT(s.out.roll, 100);
}

static void test_old_or_repeated_sequence_numbers_are_ignored(void)
{
    safety_t s;
    armed(&s);
    stick_cmd_t c = { .pitch = 200 };
    CHECK(safety_control(&s, 7, 5, &c, 100 * MS));
    CHECK(!safety_control(&s, 7, 5, &c, 250 * MS));   /* repeat does not refresh the link */
    CHECK(!safety_control(&s, 7, 4, &c, 250 * MS));
    safety_tick(&s, 401 * MS);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_CMD_TIMEOUT);
}

static void test_values_are_clamped(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 1);
    stick_cmd_t c = { .roll = 30000, .pitch = -30000, .yaw = 5, .throttle = 4000, .mode = 9 };
    CHECK(safety_control(&s, 1, 1, &c, 0));
    CHECK_EQ_INT(s.out.roll, 1000);
    CHECK_EQ_INT(s.out.pitch, -1000);
    CHECK_EQ_INT(s.out.throttle, 1000);
    CHECK_EQ_INT(s.out.mode, 2);
}

static void test_arm_refusals(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    CHECK_EQ_INT(safety_arm(&s, 7, 0), REFUSE_LINK_STALE);       /* no command yet */
    stick_cmd_t high = { .throttle = 51 };
    CHECK(safety_control(&s, 7, 1, &high, 0));
    CHECK_EQ_INT(safety_arm(&s, 7, 0), REFUSE_THROTTLE_HIGH);
    CHECK(safety_control(&s, 7, 2, &LOW, 0));
    CHECK_EQ_INT(safety_arm(&s, 9, 0), REFUSE_WRONG_SESSION);
    CHECK_EQ_INT(safety_arm(&s, 7, 301 * MS), REFUSE_LINK_STALE); /* link went stale */
    CHECK_EQ_INT(safety_arm(&s, 7, 300 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    CHECK(s.out.arm);
    CHECK_EQ_INT(safety_arm(&s, 7, 300 * MS), REFUSE_NOT_DISARMED);
}

static void test_timeout_boundary(void)
{
    safety_t s;
    armed(&s);
    safety_tick(&s, TIMEOUT);              /* exactly at the limit: still fresh */
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    safety_tick(&s, TIMEOUT + 1);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
}

static void test_failsafe_outputs(void)
{
    safety_t s;
    armed(&s);
    stick_cmd_t c = { .roll = 500, .pitch = 500, .yaw = 500, .throttle = 600, .mode = 1 };
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    safety_tick(&s, 400 * MS);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK(s.out.failsafe);
    CHECK(s.out.arm);                      /* ARM untouched: Betaflight runs its procedure */
    CHECK_EQ_INT(s.out.roll, 0);
    CHECK_EQ_INT(s.out.pitch, 0);
    CHECK_EQ_INT(s.out.yaw, 0);
    CHECK_EQ_INT(s.out.throttle, 0);
    CHECK_EQ_INT(s.out.mode, 1);
}

static void test_commands_in_failsafe_refresh_link_but_not_sticks(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    stick_cmd_t c = { .roll = 700, .throttle = 900 };
    CHECK(safety_control(&s, 7, 2, &c, 50 * MS));
    CHECK(safety_link_fresh(&s, 50 * MS));
    CHECK_EQ_INT(s.out.roll, 0);
    CHECK_EQ_INT(s.out.throttle, 0);
}

static void test_disarmed_timeout_does_not_latch(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    CHECK(safety_control(&s, 7, 1, &LOW, 0));
    safety_tick(&s, 10000 * MS);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
}

static void test_pilot_lost_while_armed(void)
{
    safety_t s;
    armed(&s);
    safety_pilot_lost(&s, 8, 0);            /* someone else's session: ignored */
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    safety_pilot_lost(&s, 7, 0);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_PILOT_LOST);
    CHECK(!safety_control(&s, 7, 9, &LOW, 1 * MS));   /* late message from that session */
}

static void test_gateway_lost_while_armed(void)
{
    safety_t s;
    armed(&s);
    safety_gateway_lost(&s);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_GATEWAY_LOST);
}

static void test_new_session_while_armed(void)
{
    safety_t s;
    armed(&s);
    safety_session_start(&s, 8);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_SESSION_CHANGED);
}

static void test_first_failsafe_reason_is_kept(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    safety_gateway_lost(&s);
    CHECK_EQ_INT(s.fs_reason, FS_MANUAL);
}

static void test_ack_refusals_and_success(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    stick_cmd_t high = { .throttle = 400 };

    CHECK_EQ_INT(safety_ack(&s, 9, 10 * MS), REFUSE_WRONG_SESSION);
    CHECK_EQ_INT(safety_ack(&s, 7, 400 * MS), REFUSE_LINK_STALE);
    CHECK(safety_control(&s, 7, 2, &high, 400 * MS));
    CHECK_EQ_INT(safety_ack(&s, 7, 400 * MS), REFUSE_THROTTLE_HIGH);
    CHECK(safety_control(&s, 7, 3, &LOW, 410 * MS));
    safety_fc_flight_mode(&s, "!FS!", 405 * MS);                     /* FC still armed */
    CHECK_EQ_INT(safety_ack(&s, 7, 420 * MS), REFUSE_FC_STILL_ARMED);
    safety_fc_flight_mode(&s, "!FS!*", 430 * MS);                    /* FC disarmed */
    CHECK_EQ_INT(safety_ack(&s, 7, 440 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK_EQ_INT(s.fs_reason, FS_NONE);
    CHECK(!s.out.arm);
    CHECK(!s.out.failsafe);
}

static void test_stale_fc_report_does_not_block_ack(void)
{
    safety_t s;
    armed(&s);
    safety_fc_flight_mode(&s, "ACRO", 0);
    safety_trigger(&s, FS_MANUAL);
    CHECK(safety_control(&s, 7, 2, &LOW, 3100 * MS));
    CHECK_EQ_INT(safety_ack(&s, 7, 3100 * MS), REFUSE_NONE);    /* report older than 3 s */
}

static void test_ack_outside_failsafe_is_refused(void)
{
    safety_t s;
    armed(&s);
    CHECK_EQ_INT(safety_ack(&s, 7, 0), REFUSE_NOT_IN_FAILSAFE);
}

static void test_rearm_after_ack_needs_explicit_arm(void)
{
    safety_t s;
    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    CHECK(safety_control(&s, 7, 2, &LOW, 10 * MS));
    CHECK_EQ_INT(safety_ack(&s, 7, 10 * MS), REFUSE_NONE);
    CHECK(!s.out.arm);
    CHECK_EQ_INT(safety_arm(&s, 7, 10 * MS), REFUSE_NONE);
    CHECK(s.out.arm);
}

static void test_disarm(void)
{
    safety_t s;
    armed(&s);
    safety_disarm(&s, 7);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.arm);

    armed(&s);
    safety_trigger(&s, FS_MANUAL);
    safety_disarm(&s, 7);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);   /* still latched */
    CHECK(!s.out.arm);
    CHECK(s.out.failsafe);
}

static void test_manual_failsafe_from_disarmed(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    safety_manual_failsafe(&s, 7);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK(s.out.failsafe);
    CHECK(!s.out.arm);
}

static void test_flight_mode_parsing(void)
{
    safety_t s;
    setup(&s);
    safety_fc_flight_mode(&s, "ACRO*", 0);
    CHECK_EQ_INT(s.fc_arm, FC_DISARMED);
    safety_fc_flight_mode(&s, "AIR", 0);
    CHECK_EQ_INT(s.fc_arm, FC_ARMED);
    safety_fc_flight_mode(&s, "", 0);
    CHECK_EQ_INT(s.fc_arm, FC_UNKNOWN);
}

static void test_names(void)
{
    CHECK_STR(safety_state_name(SAFETY_FAILSAFE), "FAILSAFE");
    CHECK_STR(safety_reason_name(FS_CMD_TIMEOUT), "cmd_timeout");
    CHECK_STR(safety_refuse_name(REFUSE_FC_STILL_ARMED), "fc_still_armed");
}

static void test_speed_and_turtle_follow_the_command_and_are_clamped(void)
{
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    stick_cmd_t c = { .speed = 2, .turtle = true };
    CHECK(safety_control(&s, 7, 1, &c, 0));
    CHECK_EQ_INT(s.out.speed, 2);
    CHECK(s.out.turtle);
    c.speed = 9;                                   /* garbage from a buggy client */
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    CHECK_EQ_INT(s.out.speed, 2);
}

static void test_failsafe_forces_turtle_off_and_keeps_speed(void)
{
    /* Spec §3.4: like the sticks, turtle must not stay on once the core has lost the pilot. */
    safety_t s;
    armed(&s);
    stick_cmd_t c = { .speed = 1, .turtle = true };
    CHECK(safety_control(&s, 7, 2, &c, 10 * MS));
    CHECK(s.out.turtle);
    safety_tick(&s, 400 * MS);                     /* no fresh command for 390 ms */
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK(!s.out.turtle);
    CHECK_EQ_INT(s.out.speed, 1);
    CHECK(safety_control(&s, 7, 3, &c, 410 * MS)); /* commands in FAILSAFE change nothing */
    CHECK(!s.out.turtle);
}

static void test_losing_the_pilot_or_gateway_drops_turtle_even_disarmed(void)
{
    /* Review: disarmed, Turtle on, then the tab dies or the gateway goes. Nobody is in
     * control, so CH8 must not stay high (an upside-down drone would stay latched in turtle). */
    safety_t s;
    setup(&s);
    safety_session_start(&s, 7);
    stick_cmd_t c = { .speed = 1, .turtle = true };
    CHECK(safety_control(&s, 7, 1, &c, 0));
    CHECK(s.out.turtle);
    safety_pilot_lost(&s, 7, 0);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.turtle);
    CHECK_EQ_INT(s.out.speed, 1);

    safety_session_start(&s, 8);
    CHECK(safety_control(&s, 8, 1, &c, 10 * MS));
    CHECK(s.out.turtle);
    safety_gateway_lost(&s);
    CHECK(!s.out.turtle);
}

static void test_standby_zero_clears_the_standby(void)
{
    safety_t s;
    safety_init(&s, 300 * MS, 500 * MS, 100);
    safety_set_standby(&s, 9);                   /* registered while session is 0 */
    CHECK_EQ_INT(s.standby, 9);
    safety_set_standby(&s, 0);
    CHECK_EQ_INT(s.standby, 0);
}

static void test_standby_equal_to_active_is_ignored(void)
{
    safety_t s;
    armed(&s);
    safety_set_standby(&s, 7);
    CHECK_EQ_INT(s.standby, 0);
}

#define HOLD (5000 * MS)
#define LAND (6000 * MS)
#define HT 450
#define T0 (TIMEOUT + 1)               /* first tick without a fresh command */

/* Session 7 armed at t=0 flying at throttle 600, hold enabled, standby 9. */
static void flying(safety_t *s)
{
    armed(s);
    safety_set_hold(s, HOLD, LAND, HT);
    stick_cmd_t c = { .roll = 100, .throttle = 600, .mode = 2, .speed = 1, .turtle = false };
    CHECK(safety_control(s, 7, 2, &c, 0));
    safety_set_standby(s, 9);
}

/* Pops the next report and checks it. */
static void check_report(safety_t *s, hold_ev_t ev, fs_reason_t why, uint32_t session)
{
    hold_ev_t e;
    fs_reason_t r;
    uint32_t ses;
    CHECK(safety_take_report(s, &e, &r, &ses));
    CHECK_STR(safety_hold_ev_name(e), safety_hold_ev_name(ev));
    CHECK_STR(safety_reason_name(r), safety_reason_name(why));
    CHECK_EQ_INT(ses, session);
}

static bool no_report(safety_t *s)
{
    hold_ev_t e;
    fs_reason_t r;
    uint32_t ses;
    return !safety_take_report(s, &e, &r, &ses);
}

static void test_timeout_enters_hold_with_hold_outputs(void)
{
    safety_t s;
    flying(&s);
    stick_cmd_t c = { .roll = 100, .pitch = -50, .yaw = 30, .throttle = 600, .mode = 2, .speed = 1,
                      .turtle = true };
    CHECK(safety_control(&s, 7, 3, &c, 0));
    safety_tick(&s, TIMEOUT);
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    safety_tick(&s, T0);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK(s.out.arm);
    CHECK_EQ_INT(s.out.roll, 0);
    CHECK_EQ_INT(s.out.pitch, 0);
    CHECK_EQ_INT(s.out.yaw, 0);
    CHECK_EQ_INT(s.out.throttle, HT);
    CHECK_EQ_INT(s.out.mode, 0);            /* Normal: the mode that holds height */
    CHECK_EQ_INT(s.out.speed, 1);           /* kept */
    CHECK(!s.out.turtle);
    CHECK(!s.out.failsafe);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    CHECK(no_report(&s));
}

static void test_hold_off_still_fails_safe_at_once(void)
{
    safety_t s;
    armed(&s);                              /* no safety_set_hold: hold_ns = 0 */
    safety_tick(&s, T0);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_STR(safety_reason_name(s.fs_reason), "cmd_timeout");
    CHECK(no_report(&s));
}

static void test_pilot_lost_enters_hold(void)
{
    safety_t s;
    flying(&s);
    safety_pilot_lost(&s, 7, 100 * MS);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK_EQ_INT(s.out.throttle, HT);
    check_report(&s, HOLD_EV_HOLD, FS_PILOT_LOST, 7);
    stick_cmd_t c = { .throttle = 610 };
    CHECK(!safety_control(&s, 7, 3, &c, 110 * MS));   /* that session is gone: no resume */
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK_EQ_INT(s.out.throttle, HT);
}

static void test_low_throttle_skips_hold_and_lands(void)
{
    /* Maybe on the ground: hold_throttle would lift it. */
    safety_t s;
    armed(&s);
    safety_set_hold(&s, HOLD, LAND, HT);
    stick_cmd_t c = { .throttle = 50, .mode = 2 };
    CHECK(safety_control(&s, 7, 2, &c, 0));
    safety_set_standby(&s, 9);
    safety_tick(&s, T0);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    CHECK_EQ_INT(s.out.throttle, 0);
    CHECK_EQ_INT(s.out.mode, 0);
    CHECK(s.out.arm);
    CHECK(!s.out.failsafe);
    check_report(&s, HOLD_EV_LANDING, FS_CMD_TIMEOUT, 7);
    CHECK(no_report(&s));
}

static void test_resume_by_the_same_session(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    stick_cmd_t c = { .throttle = 610 };
    CHECK(safety_control(&s, 7, 3, &c, T0 + 10 * MS));
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    CHECK_EQ_INT(s.out.throttle, 610);
    check_report(&s, HOLD_EV_RESUMED, FS_CMD_TIMEOUT, 7);
    CHECK(no_report(&s));
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0 + 10 * MS), 0);
}

static void test_no_resume_during_landing(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    safety_tick(&s, T0 + HOLD - 1);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    safety_tick(&s, T0 + HOLD);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    stick_cmd_t c = { .throttle = 610 };
    safety_control(&s, 7, 3, &c, T0 + HOLD + 10 * MS);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    CHECK_EQ_INT(s.out.throttle, 0);
}

static void test_hold_expires_into_landing_then_failsafe(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    safety_tick(&s, T0 + HOLD);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    CHECK_EQ_INT(s.out.throttle, 0);
    CHECK(s.out.arm);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    check_report(&s, HOLD_EV_LANDING, FS_CMD_TIMEOUT, 7);
    safety_tick(&s, T0 + HOLD + LAND - 1);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    safety_tick(&s, T0 + HOLD + LAND);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_CMD_TIMEOUT);    /* the reason that started the hold */
    CHECK(s.out.failsafe);                         /* ARM low on the air */
    CHECK_EQ_INT(s.session, 7);                    /* the page is still there: it keeps the seat */
    CHECK(no_report(&s));
}

static void test_pilot_lost_landing_clears_the_session(void)
{
    safety_t s;
    flying(&s);
    safety_pilot_lost(&s, 7, 0);
    safety_tick(&s, HOLD);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    safety_tick(&s, HOLD + LAND);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_PILOT_LOST);
    CHECK_EQ_INT(s.session, 0);
    CHECK(!safety_control(&s, 7, 3, &LOW, HOLD + LAND + 10 * MS));
}

static void test_take_only_from_standby(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    CHECK_EQ_INT(safety_take(&s, 8, T0), REFUSE_NOT_STANDBY);
    CHECK_EQ_INT(safety_take(&s, 7, T0), REFUSE_NOT_STANDBY);
    CHECK_EQ_INT(safety_take(&s, 0, T0), REFUSE_NOT_STANDBY);
    CHECK_EQ_INT(s.session, 7);

    flying(&s);
    CHECK_EQ_INT(safety_take(&s, 9, 10 * MS), REFUSE_NOT_IN_HOLD);
    CHECK_EQ_INT(s.session, 7);
    CHECK_EQ_INT(s.standby, 9);
}

static void test_take_switches_session_and_stays_hold_until_first_command(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    CHECK_EQ_INT(safety_take(&s, 9, T0 + 10 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.session, 9);
    CHECK_EQ_INT(s.standby, 0);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK(s.out.arm);
    CHECK_EQ_INT(s.out.throttle, HT);
    CHECK_EQ_INT(s.out.mode, 0);
    check_report(&s, HOLD_EV_TAKEN, FS_CMD_TIMEOUT, 9);
    CHECK(no_report(&s));
    stick_cmd_t c = { .throttle = 610 };
    CHECK(!safety_control(&s, 7, 3, &c, T0 + 15 * MS));  /* the old session is refused */
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    c.throttle = 455;
    CHECK(safety_control(&s, 9, 1, &c, T0 + 20 * MS));   /* new session starts at seq 1 */
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    CHECK_EQ_INT(s.out.throttle, 455);
    CHECK(s.out.arm);
    CHECK(no_report(&s));                    /* taken was reported at the TAKE */
}

static void test_take_during_landing(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    safety_tick(&s, T0 + HOLD);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    CHECK_EQ_INT(safety_take(&s, 9, T0 + HOLD + 10 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    CHECK_EQ_INT(s.out.throttle, 0);
    stick_cmd_t c = { .throttle = 300 };
    CHECK(safety_control(&s, 9, 1, &c, T0 + HOLD + 20 * MS));
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    CHECK_EQ_INT(s.out.throttle, 300);
}

static void test_take_countdown_keeps_running(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    CHECK_EQ_INT(safety_take(&s, 9, TIMEOUT + 100 * MS), REFUSE_NONE);
    safety_tick(&s, T0 + HOLD - 1);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    safety_tick(&s, T0 + HOLD);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
}

static void test_taker_lost_before_first_command_lands_on_time(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    CHECK_EQ_INT(safety_take(&s, 9, T0 + 10 * MS), REFUSE_NONE);
    safety_pilot_lost(&s, 9, T0 + 200 * MS);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK(!safety_control(&s, 9, 1, &LOW, T0 + 210 * MS));
    safety_tick(&s, T0 + HOLD);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    safety_tick(&s, T0 + HOLD + LAND);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(s.fs_reason, FS_CMD_TIMEOUT);
    CHECK_EQ_INT(s.session, 0);
}

static void test_second_loss_after_take_starts_a_new_hold(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    CHECK_EQ_INT(safety_take(&s, 9, T0 + 10 * MS), REFUSE_NONE);
    int64_t t1 = T0 + 20 * MS;
    stick_cmd_t c = { .throttle = 455 };
    CHECK(safety_control(&s, 9, 1, &c, t1));
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    check_report(&s, HOLD_EV_TAKEN, FS_CMD_TIMEOUT, 9);
    safety_tick(&s, t1 + TIMEOUT);
    CHECK_EQ_INT(s.state, SAFETY_ARMED);
    safety_tick(&s, t1 + TIMEOUT + 1);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK_EQ_INT(safety_stage_left_ms(&s, t1 + TIMEOUT + 1), 5000);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 9);
}

static void test_land_only_from_standby_in_hold(void)
{
    safety_t s;
    flying(&s);
    CHECK_EQ_INT(safety_land(&s, 9, 10 * MS), REFUSE_NOT_IN_HOLD);   /* ARMED */
    safety_tick(&s, T0);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    CHECK_EQ_INT(safety_land(&s, 8, T0 + 10 * MS), REFUSE_NOT_STANDBY);
    CHECK_EQ_INT(safety_land(&s, 7, T0 + 10 * MS), REFUSE_NOT_STANDBY);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    CHECK_EQ_INT(safety_land(&s, 9, T0 + 10 * MS), REFUSE_NONE);
    CHECK_EQ_INT(s.state, SAFETY_LANDING);
    CHECK_EQ_INT(s.out.throttle, 0);
    CHECK_EQ_INT(s.session, 7);
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0 + 10 * MS), 6000);
    check_report(&s, HOLD_EV_LANDING, FS_CMD_TIMEOUT, 7);
    CHECK_EQ_INT(safety_land(&s, 9, T0 + 20 * MS), REFUSE_NOT_IN_HOLD);
}

/* Flying, then HOLD at T0; with `landing`, LAND from the standby right away. */
static void in_stage(safety_t *s, bool landing)
{
    flying(s);
    safety_tick(s, T0);
    if (landing)
        CHECK_EQ_INT(safety_land(s, 9, T0), REFUSE_NONE);
    CHECK_EQ_INT(s->state, landing ? SAFETY_LANDING : SAFETY_HOLD);
}

static void test_instant_paths_from_hold_and_landing(void)
{
    for (int landing = 0; landing <= 1; landing++) {
        safety_t s;

        in_stage(&s, landing);
        safety_disarm(&s, 8);                         /* someone else: ignored */
        CHECK(s.out.arm);
        safety_disarm(&s, 7);
        CHECK_EQ_INT(s.state, SAFETY_DISARMED);
        CHECK(!s.out.arm);
        CHECK_EQ_INT(safety_stage_left_ms(&s, T0), 0);

        in_stage(&s, landing);
        safety_manual_failsafe(&s, 7);
        CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
        CHECK_STR(safety_reason_name(s.fs_reason), "manual");

        in_stage(&s, landing);
        safety_gateway_lost(&s);
        CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
        CHECK_STR(safety_reason_name(s.fs_reason), "gateway_lost");

        in_stage(&s, landing);
        safety_session_start(&s, 5);
        CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
        CHECK_STR(safety_reason_name(s.fs_reason), "session_changed");

        in_stage(&s, landing);
        safety_set_rf_timeout(&s, 1000 * MS);         /* no link report since t=0 */
        safety_tick(&s, 1000 * MS);
        CHECK_EQ_INT(s.state, landing ? SAFETY_LANDING : SAFETY_HOLD);
        safety_tick(&s, 1000 * MS + 1);
        CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
        CHECK_STR(safety_reason_name(s.fs_reason), "rf_lost");
        CHECK(s.out.failsafe);
    }
}

static void test_lost_seat_stays_lost_after_disarm(void)
{
    /* The pilot_lost session's Desarmar is obeyed, but it does not get the seat back. */
    safety_t s;
    flying(&s);
    safety_pilot_lost(&s, 7, 10 * MS);
    safety_disarm(&s, 7);
    CHECK_EQ_INT(s.state, SAFETY_DISARMED);
    CHECK(!s.out.arm);
    CHECK_EQ_INT(s.session, 0);
    CHECK(!safety_control(&s, 7, 3, &LOW, 20 * MS));
}

static void test_stage_left_counts_down(void)
{
    safety_t s;
    flying(&s);
    CHECK_EQ_INT(safety_stage_left_ms(&s, 0), 0);                /* ARMED */
    safety_tick(&s, T0);
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0), 5000);
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0 + 1000 * MS), 4000);
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0 + 1000 * MS + 1), 4000);   /* rounded up */
    safety_tick(&s, T0 + HOLD);
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0 + HOLD), 6000);
    safety_tick(&s, T0 + HOLD + LAND);
    CHECK_EQ_INT(s.state, SAFETY_FAILSAFE);
    CHECK_EQ_INT(safety_stage_left_ms(&s, T0 + HOLD + LAND), 0);
}

static void test_arm_and_ack_unaffected(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);
    CHECK_EQ_INT(safety_arm(&s, 7, T0), REFUSE_NOT_DISARMED);
    CHECK_EQ_INT(safety_ack(&s, 7, T0), REFUSE_NOT_IN_FAILSAFE);
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
}

static void test_report_fifo_drops_the_newest_on_overflow(void)
{
    safety_t s;
    flying(&s);
    safety_tick(&s, T0);                                         /* 1: hold */
    stick_cmd_t c = { .throttle = 600 };
    CHECK(safety_control(&s, 7, 3, &c, T0 + 10 * MS));           /* 2: resumed */
    safety_tick(&s, T0 + 10 * MS + T0);                          /* 3: hold */
    CHECK(safety_control(&s, 7, 4, &c, T0 + 20 * MS + T0));      /* 4: resumed */
    safety_tick(&s, T0 + 20 * MS + 2 * T0);                      /* 5: dropped */
    CHECK_EQ_INT(s.state, SAFETY_HOLD);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    check_report(&s, HOLD_EV_RESUMED, FS_CMD_TIMEOUT, 7);
    check_report(&s, HOLD_EV_HOLD, FS_CMD_TIMEOUT, 7);
    check_report(&s, HOLD_EV_RESUMED, FS_CMD_TIMEOUT, 7);
    CHECK(no_report(&s));
}

static void test_hold_names(void)
{
    CHECK_STR(safety_state_name(SAFETY_HOLD), "HOLD");
    CHECK_STR(safety_state_name(SAFETY_LANDING), "LANDING");
    CHECK_EQ_INT(SAFETY_HOLD, 3);
    CHECK_EQ_INT(SAFETY_LANDING, 4);
    CHECK_STR(safety_refuse_name(REFUSE_NOT_STANDBY), "not_standby");
    CHECK_STR(safety_refuse_name(REFUSE_NOT_IN_HOLD), "not_in_hold");
    CHECK_STR(safety_hold_ev_name(HOLD_EV_HOLD), "hold");
    CHECK_STR(safety_hold_ev_name(HOLD_EV_RESUMED), "resumed");
    CHECK_STR(safety_hold_ev_name(HOLD_EV_TAKEN), "taken");
    CHECK_STR(safety_hold_ev_name(HOLD_EV_LANDING), "landing");
}

int main(void)
{
    RUN(test_starts_disarmed_with_safe_outputs);
    RUN(test_commands_need_the_current_session);
    RUN(test_old_or_repeated_sequence_numbers_are_ignored);
    RUN(test_values_are_clamped);
    RUN(test_arm_refusals);
    RUN(test_timeout_boundary);
    RUN(test_failsafe_outputs);
    RUN(test_commands_in_failsafe_refresh_link_but_not_sticks);
    RUN(test_disarmed_timeout_does_not_latch);
    RUN(test_pilot_lost_while_armed);
    RUN(test_gateway_lost_while_armed);
    RUN(test_new_session_while_armed);
    RUN(test_first_failsafe_reason_is_kept);
    RUN(test_ack_refusals_and_success);
    RUN(test_stale_fc_report_does_not_block_ack);
    RUN(test_ack_outside_failsafe_is_refused);
    RUN(test_rearm_after_ack_needs_explicit_arm);
    RUN(test_disarm);
    RUN(test_manual_failsafe_from_disarmed);
    RUN(test_flight_mode_parsing);
    RUN(test_names);
    RUN(test_radio_link_loss_fails_safe_when_enabled);
    RUN(test_radio_link_check_is_off_by_default);
    RUN(test_arm_needs_a_live_radio_link_when_enabled);
    RUN(test_arm_ignores_the_radio_link_by_default);
    RUN(test_speed_and_turtle_follow_the_command_and_are_clamped);
    RUN(test_failsafe_forces_turtle_off_and_keeps_speed);
    RUN(test_losing_the_pilot_or_gateway_drops_turtle_even_disarmed);
    RUN(test_standby_zero_clears_the_standby);
    RUN(test_standby_equal_to_active_is_ignored);
    RUN(test_timeout_enters_hold_with_hold_outputs);
    RUN(test_hold_off_still_fails_safe_at_once);
    RUN(test_pilot_lost_enters_hold);
    RUN(test_low_throttle_skips_hold_and_lands);
    RUN(test_resume_by_the_same_session);
    RUN(test_no_resume_during_landing);
    RUN(test_hold_expires_into_landing_then_failsafe);
    RUN(test_pilot_lost_landing_clears_the_session);
    RUN(test_take_only_from_standby);
    RUN(test_take_switches_session_and_stays_hold_until_first_command);
    RUN(test_take_during_landing);
    RUN(test_take_countdown_keeps_running);
    RUN(test_taker_lost_before_first_command_lands_on_time);
    RUN(test_second_loss_after_take_starts_a_new_hold);
    RUN(test_land_only_from_standby_in_hold);
    RUN(test_instant_paths_from_hold_and_landing);
    RUN(test_lost_seat_stays_lost_after_disarm);
    RUN(test_stage_left_counts_down);
    RUN(test_arm_and_ack_unaffected);
    RUN(test_report_fifo_drops_the_newest_on_overflow);
    RUN(test_hold_names);
    return CHECK_EXIT();
}
