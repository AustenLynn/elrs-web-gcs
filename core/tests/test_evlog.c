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

static void test_refused_and_timing_events(void)
{
    char out[512];
    core_event_t r = { .kind = EV_REFUSED, .t_ns = 1, .a = CMD_ACK, .b = REFUSE_FC_STILL_ARMED, .session = 3 };
    CHECK(evlog_format(out, sizeof out, &r, W) > 0);
    CHECK(strstr(out, "\"ev\":\"refused\",\"what\":\"ack\",\"reason\":\"fc_still_armed\"") != NULL);

    core_event_t t = { .kind = EV_TIMING, .t_ns = 1, .a = 40000, .b = -1234 };
    CHECK(evlog_format(out, sizeof out, &t, W) > 0);
    CHECK(strstr(out, "\"interval_us\":4000.0,\"offset_us\":-123.4}") != NULL);
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
    RUN(test_refused_and_timing_events);
    RUN(test_text_from_aircraft_is_sanitised);
    RUN(test_small_buffer_returns_zero);
    return CHECK_EXIT();
}
