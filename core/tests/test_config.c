#define _GNU_SOURCE
#include "check.h"
#include "config.h"

#include <stdlib.h>
#include <unistd.h>

static char err[256];

static const char *write_temp(const char *text)
{
    static char path[] = "/tmp/crsf-config-XXXXXX";
    snprintf(path, sizeof path, "/tmp/crsf-config-XXXXXX");
    int fd = mkstemp(path);
    if (fd < 0)
        return NULL;
    if (write(fd, text, strlen(text)) < 0)
        return NULL;
    close(fd);
    return path;
}

static void test_defaults_are_valid(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(c.ch_arm, 4);
    CHECK_EQ_INT(c.cmd_timeout_ms, 300);
}

static void test_status_socket_is_separate_from_the_control_socket(void)
{
    /* Read-only tools (crsf-ctl status/watch) use their own socket, so they can never
     * replace the gateway on the control socket. */
    config_t c;
    config_defaults(&c);
    CHECK_STR(c.status_socket_path, "");                  /* off unless configured */
    CHECK_EQ_INT(config_set(&c, "status_socket_path", "/run/crsf-core/core.sock", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "status_socket_path", "/run/crsf-core/status.sock", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
}

static void test_fc_profile_defaults_to_aquila20(void)
{
    /* The project drone (BetaFPV Aquila20) does not run Betaflight; Betaflight stays selectable. */
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_AQUILA20);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "betaflight", err, sizeof err), 0);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_BETAFLIGHT);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "aquila20", err, sizeof err), 0);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_AQUILA20);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "inav", err, sizeof err), -1);
    CHECK(strstr(err, "aquila20 or betaflight") != NULL);
}

static void test_aquila20_keeps_ch7_for_its_sensitivity_switch(void)
{
    /* On the Aquila20, CH7 selects stick sensitivity: it must stay at its default (low = S).
     * ch_failsafe is not used, so it may point anywhere without clashing. */
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "ch_yaw", "7", err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "ch_failsafe", "4", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK(strstr(err, "CH7") != NULL);
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_failsafe", "4", err, sizeof err), 0);   /* same as ch_yaw: unused */
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), 0);
    CHECK_EQ_INT(config_set(&c, "fc_profile", "betaflight", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);                /* betaflight uses it */
}

static void test_load_file_with_comments_and_spaces(void)
{
    const char *path = write_temp(
        "# crsf-core test config\n"
        "serial_device = /dev/pts/9   # fake module\n"
        "\n"
        "  baud=400000\n"
        "ch_throttle = 1\n"
        "ch_roll = 3\n"
        "rt_required = yes\n"
        "event_log = /tmp/events.jsonl\n");
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, path, err, sizeof err), 0);
    CHECK_STR(c.serial_device, "/dev/pts/9");
    CHECK_EQ_INT(c.baud, 400000);
    CHECK_EQ_INT(c.ch_throttle, 0);
    CHECK_EQ_INT(c.ch_roll, 2);
    CHECK(c.rt_required);
    CHECK_STR(c.event_log, "/tmp/events.jsonl");
    unlink(path);
}

static void test_windows_line_endings(void)
{
    const char *path = write_temp("baud = 400000\r\nrt_required = true\r\n");
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, path, err, sizeof err), 0);
    CHECK_EQ_INT(c.baud, 400000);
    CHECK(c.rt_required);
    unlink(path);
}

static void test_unknown_key_reports_line(void)
{
    const char *path = write_temp("baud = 921600\nbaudrate = 9600\n");
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, path, err, sizeof err), -1);
    CHECK(strstr(err, ":2: unknown setting \"baudrate\"") != NULL);
    unlink(path);
}

static void test_bad_values_are_rejected(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "baud", "fast", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "baud", "12x", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "17", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "0", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "rt_required", "maybe", err, sizeof err), -1);
    CHECK_EQ_INT(config_set(&c, "missing_equals", "", err, sizeof err), -1);
}

static void test_validation_rules(void)
{
    config_t c;

    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_arm", "8", err, sizeof err), 0);
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
    CHECK(strstr(err, "CH5") != NULL);

    config_defaults(&c);
    CHECK_EQ_INT(config_set(&c, "ch_mode", "7", err, sizeof err), 0);   /* same as failsafe */
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);

    config_defaults(&c);
    c.cmd_timeout_ms = 1000;
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);

    config_defaults(&c);
    c.stick_min_us = 1500;
    c.stick_max_us = 1500;
    CHECK_EQ_INT(config_validate(&c, err, sizeof err), -1);
}

static void test_missing_file(void)
{
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, "/nonexistent/crsf-core.conf", err, sizeof err), -1);
    CHECK(strstr(err, "No such file") != NULL);
}

static void test_production_config_is_valid(void)
{
    /* `make test` runs from core/, so the shipped config is one level up. */
    config_t c;
    config_defaults(&c);
    CHECK_EQ_INT(config_load(&c, "../deploy/crsf-core.conf", err, sizeof err), 0);
    CHECK(c.rt_required);
    CHECK_EQ_INT(c.ch_failsafe, 6);
    CHECK_EQ_INT(c.fc_profile, FC_PROFILE_AQUILA20);
    CHECK_STR(c.timing_log, "");
    CHECK_STR(c.status_socket_path, "/run/crsf-core/status.sock");
}

int main(void)
{
    RUN(test_defaults_are_valid);
    RUN(test_fc_profile_defaults_to_aquila20);
    RUN(test_aquila20_keeps_ch7_for_its_sensitivity_switch);
    RUN(test_status_socket_is_separate_from_the_control_socket);
    RUN(test_load_file_with_comments_and_spaces);
    RUN(test_windows_line_endings);
    RUN(test_unknown_key_reports_line);
    RUN(test_bad_values_are_rejected);
    RUN(test_validation_rules);
    RUN(test_missing_file);
    RUN(test_production_config_is_valid);
    return CHECK_EXIT();
}
