#include "check.h"
#include "evlog.h"

static const char *W = "2026-10-05T18:20:01.123Z";

static void test_state_event(void)
{
    core_event_t ev = { .kind = EV_STATE, .t_ns = 42, .a = SAFETY_ARMED, .b = SAFETY_FAILSAFE,
                        .c = FS_CMD_TIMEOUT, .session = 7, .cmd_age_ms = 301 };
    char out[512];
    CHECK(evlog_format(out, sizeof out, &ev, W) > 0);
    CHECK_STR(out, "{\"t_ns\":42,\"wall\":\"2026-10-05T18:20:01.123Z\",\"ev\":\"state\",\"from\":\"ARMED\","
                   "\"to\":\"FAILSAFE\",\"reason\":\"cmd_timeout\",\"session\":7,\"cmd_age_ms\":301}");
}

static void test_hold_lines(void)
{
    core_event_t ev = { .kind = EV_HOLD, .t_ns = 5, .a = HOLD_EV_TAKEN, .b = FS_PILOT_LOST, .session = 9,
                        .cmd_age_ms = 120 };
    char out[512];
    CHECK(evlog_format(out, sizeof out, &ev, W) > 0);
    CHECK(strstr(out, "\"ev\":\"taken\",\"reason\":\"pilot_lost\",\"session\":9,\"cmd_age_ms\":120}") != NULL);
    ev.a = HOLD_EV_HOLD;
    ev.b = FS_CMD_TIMEOUT;
    CHECK(evlog_format(out, sizeof out, &ev, W) > 0);
    CHECK(strstr(out, "\"ev\":\"hold\",\"reason\":\"cmd_timeout\",\"session\":9,") != NULL);
}

static void test_refused_and_timing_events(void)
{
    char out[512];
    core_event_t r = { .kind = EV_REFUSED, .t_ns = 1, .a = CMD_ACK, .b = REFUSE_FC_STILL_ARMED, .session = 3 };
    CHECK(evlog_format(out, sizeof out, &r, W) > 0);
    CHECK(strstr(out, "\"ev\":\"refused\",\"what\":\"ack\",\"reason\":\"fc_still_armed\"") != NULL);
    r.a = CMD_TAKE;
    r.b = REFUSE_NOT_STANDBY;
    CHECK(evlog_format(out, sizeof out, &r, W) > 0);
    CHECK(strstr(out, "\"ev\":\"refused\",\"what\":\"take\",\"reason\":\"not_standby\"") != NULL);
    r.a = CMD_LAND;
    r.b = REFUSE_NOT_IN_HOLD;
    CHECK(evlog_format(out, sizeof out, &r, W) > 0);
    CHECK(strstr(out, "\"ev\":\"refused\",\"what\":\"land\",\"reason\":\"not_in_hold\"") != NULL);

    core_event_t t = { .kind = EV_TIMING, .t_ns = 1, .a = 40000, .b = -1234 };
    CHECK(evlog_format(out, sizeof out, &t, W) > 0);
    CHECK(strstr(out, "\"interval_us\":4000.0,\"offset_us\":-123.4}") != NULL);
}

static void test_sticks_event(void)
{
    /* Values on the air while armed, in % like the page's readouts (flight test 2026-10-09). */
    core_event_t ev = { .kind = EV_STICKS, .t_ns = 5, .a = -120, .b = 50, .c = 0, .d = 235,
                        .e = 0, .f = 1, .g = 2, .h = 1, .cmd_age_ms = 14 };
    char out[512];
    CHECK(evlog_format(out, sizeof out, &ev, W) > 0);
    CHECK_STR(out, "{\"t_ns\":5,\"wall\":\"2026-10-05T18:20:01.123Z\",\"ev\":\"sticks\",\"roll\":-12.0,"
                   "\"pitch\":5.0,\"yaw\":0.0,\"thr\":23.5,\"mode\":0,\"speed\":2,\"turtle\":true,\"arm\":true,\"cmd_age_ms\":14}");
    ev.f = 0;
    ev.a = -5;
    CHECK(evlog_format(out, sizeof out, &ev, W) > 0);
    CHECK(strstr(out, "\"roll\":-0.5,") != NULL);
    CHECK(strstr(out, "\"arm\":false,") != NULL);
}

static void test_text_from_aircraft_is_sanitised(void)
{
    core_event_t ev = { .kind = EV_FLIGHT_MODE, .t_ns = 1 };
    snprintf(ev.text, sizeof ev.text, "A\"B\\C\nD");
    char out[512];
    CHECK(evlog_format(out, sizeof out, &ev, W) > 0);
    CHECK(strstr(out, "\"mode\":\"A?B?C?D\"}") != NULL);
}

static void test_small_buffer_returns_zero(void)
{
    core_event_t ev = { .kind = EV_SERIAL, .a = 1 };
    char out[16];
    CHECK_EQ_INT(evlog_format(out, sizeof out, &ev, W), 0);
}

int main(void)
{
    RUN(test_state_event);
    RUN(test_hold_lines);
    RUN(test_refused_and_timing_events);
    RUN(test_sticks_event);
    RUN(test_text_from_aircraft_is_sanitised);
    RUN(test_small_buffer_returns_zero);
    return CHECK_EXIT();
}
