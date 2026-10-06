#include "config.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void config_defaults(config_t *c)
{
    memset(c, 0, sizeof *c);
    snprintf(c->serial_device, sizeof c->serial_device, "/dev/ttyUSB0");
    c->baud = 921600;
    snprintf(c->socket_path, sizeof c->socket_path, "/run/crsf-core/core.sock");
    c->default_period_us = 4000;
    c->sync_margin_us = 1000;
    c->cmd_timeout_ms = 300;
    c->throttle_arm_max = 50;
    c->fc_armed_fresh_ms = 3000;
    c->model_id = 0;
    c->rt_priority = 80;
    c->rt_cpu = 3;
    c->rt_required = false;
    c->stick_min_us = 1000;
    c->stick_max_us = 2000;
    c->ch_roll = 0;      /* CH1 */
    c->ch_pitch = 1;     /* CH2 */
    c->ch_throttle = 2;  /* CH3 */
    c->ch_yaw = 3;       /* CH4 */
    c->ch_arm = 4;       /* CH5 = AUX1: ExpressLRS sends it with every packet */
    c->ch_mode = 5;      /* CH6 = AUX2 */
    c->ch_failsafe = 6;  /* CH7 = AUX3 */
}

static int parse_int(const char *s, int *out)
{
    char *end;
    errno = 0;
    long v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || v < -1000000000L || v > 1000000000L)
        return -1;
    *out = (int)v;
    return 0;
}

static int parse_bool(const char *s, bool *out)
{
    if (!strcmp(s, "true") || !strcmp(s, "yes") || !strcmp(s, "1")) {
        *out = true;
        return 0;
    }
    if (!strcmp(s, "false") || !strcmp(s, "no") || !strcmp(s, "0")) {
        *out = false;
        return 0;
    }
    return -1;
}

static int set_string(char *dst, size_t cap, const char *value)
{
    if (strlen(value) >= cap)
        return -1;
    snprintf(dst, cap, "%s", value);
    return 0;
}

int config_set(config_t *c, const char *key, const char *value, char *err, size_t errlen)
{
    static const struct { const char *key; size_t off; } strings[] = {
        { "serial_device", offsetof(config_t, serial_device) },
        { "socket_path", offsetof(config_t, socket_path) },
        { "status_socket_path", offsetof(config_t, status_socket_path) },
        { "event_log", offsetof(config_t, event_log) },
        { "timing_log", offsetof(config_t, timing_log) },
    };
    static const struct { const char *key; size_t off; } ints[] = {
        { "baud", offsetof(config_t, baud) },
        { "default_period_us", offsetof(config_t, default_period_us) },
        { "sync_margin_us", offsetof(config_t, sync_margin_us) },
        { "cmd_timeout_ms", offsetof(config_t, cmd_timeout_ms) },
        { "throttle_arm_max", offsetof(config_t, throttle_arm_max) },
        { "fc_armed_fresh_ms", offsetof(config_t, fc_armed_fresh_ms) },
        { "model_id", offsetof(config_t, model_id) },
        { "rt_priority", offsetof(config_t, rt_priority) },
        { "rt_cpu", offsetof(config_t, rt_cpu) },
        { "stick_min_us", offsetof(config_t, stick_min_us) },
        { "stick_max_us", offsetof(config_t, stick_max_us) },
    };
    static const struct { const char *key; size_t off; } channels[] = {
        { "ch_roll", offsetof(config_t, ch_roll) },
        { "ch_pitch", offsetof(config_t, ch_pitch) },
        { "ch_throttle", offsetof(config_t, ch_throttle) },
        { "ch_yaw", offsetof(config_t, ch_yaw) },
        { "ch_arm", offsetof(config_t, ch_arm) },
        { "ch_mode", offsetof(config_t, ch_mode) },
        { "ch_failsafe", offsetof(config_t, ch_failsafe) },
    };
    char *base = (char *)c;

    for (size_t i = 0; i < sizeof strings / sizeof strings[0]; i++) {
        if (!strcmp(key, strings[i].key)) {
            if (set_string(base + strings[i].off, CONFIG_PATH_MAX, value) == 0)
                return 0;
            snprintf(err, errlen, "%s: value too long", key);
            return -1;
        }
    }
    for (size_t i = 0; i < sizeof ints / sizeof ints[0]; i++) {
        if (!strcmp(key, ints[i].key)) {
            if (parse_int(value, (int *)(void *)(base + ints[i].off)) == 0)
                return 0;
            snprintf(err, errlen, "%s: not an integer: \"%s\"", key, value);
            return -1;
        }
    }
    for (size_t i = 0; i < sizeof channels / sizeof channels[0]; i++) {
        if (!strcmp(key, channels[i].key)) {
            int ch;
            if (parse_int(value, &ch) != 0 || ch < 1 || ch > 16) {
                snprintf(err, errlen, "%s: must be a channel number 1..16, got \"%s\"", key, value);
                return -1;
            }
            *(int *)(void *)(base + channels[i].off) = ch - 1;
            return 0;
        }
    }
    if (!strcmp(key, "rt_required")) {
        if (parse_bool(value, &c->rt_required) == 0)
            return 0;
        snprintf(err, errlen, "rt_required: expected true or false, got \"%s\"", value);
        return -1;
    }
    snprintf(err, errlen, "unknown setting \"%s\"", key);
    return -1;
}

static int fail(char *err, size_t errlen, const char *msg)
{
    snprintf(err, errlen, "%s", msg);
    return -1;
}

int config_validate(const config_t *c, char *err, size_t errlen)
{
    if (c->serial_device[0] == '\0' || c->socket_path[0] == '\0')
        return fail(err, errlen, "serial_device and socket_path must be set");
    if (strcmp(c->status_socket_path, c->socket_path) == 0)
        return fail(err, errlen, "status_socket_path must differ from socket_path");
    if (c->baud <= 0)
        return fail(err, errlen, "baud must be positive");
    if (c->default_period_us < 500 || c->default_period_us > 50000)
        return fail(err, errlen, "default_period_us must be 500..50000");
    if (c->sync_margin_us < 0 || c->sync_margin_us > 5000)
        return fail(err, errlen, "sync_margin_us must be 0..5000");
    if (c->cmd_timeout_ms < 100 || c->cmd_timeout_ms > 900)
        return fail(err, errlen, "cmd_timeout_ms must be 100..900 (failsafe must react in < 1 s)");
    if (c->throttle_arm_max < 0 || c->throttle_arm_max > 300)
        return fail(err, errlen, "throttle_arm_max must be 0..300");
    if (c->fc_armed_fresh_ms < 0)
        return fail(err, errlen, "fc_armed_fresh_ms must be >= 0");
    if (c->model_id < 0 || c->model_id > 63)
        return fail(err, errlen, "model_id must be 0..63");
    if (c->rt_priority < 0 || c->rt_priority > 98)
        return fail(err, errlen, "rt_priority must be 0..98");
    if (c->rt_cpu < -1 || c->rt_cpu > 63)
        return fail(err, errlen, "rt_cpu must be -1..63");
    if (c->stick_min_us < 988 || c->stick_max_us > 2012 || c->stick_min_us >= c->stick_max_us)
        return fail(err, errlen, "need 988 <= stick_min_us < stick_max_us <= 2012");
    if (c->ch_arm != 4)
        return fail(err, errlen, "ch_arm must be 5: ExpressLRS sends AUX1 (CH5) with every packet");

    const int chans[] = { c->ch_roll, c->ch_pitch, c->ch_throttle, c->ch_yaw,
                          c->ch_arm, c->ch_mode, c->ch_failsafe };
    const int n = (int)(sizeof chans / sizeof chans[0]);
    for (int i = 0; i < n; i++) {
        if (chans[i] < 0 || chans[i] > 15)
            return fail(err, errlen, "channel numbers must be 1..16");
        for (int j = i + 1; j < n; j++)
            if (chans[i] == chans[j])
                return fail(err, errlen, "two functions are mapped to the same channel");
    }
    return 0;
}

static char *trim(char *s)
{
    while (isspace((unsigned char)*s))
        s++;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1]))
        *--e = '\0';
    return s;
}

int config_load(config_t *c, const char *path, char *err, size_t errlen)
{
    FILE *f = fopen(path, "r");
    if (f == NULL) {
        snprintf(err, errlen, "%s: %s", path, strerror(errno));
        return -1;
    }
    char line[512];
    int lineno = 0;
    while (fgets(line, sizeof line, f) != NULL) {
        lineno++;
        char *hash = strchr(line, '#');
        if (hash != NULL)
            *hash = '\0';
        char *s = trim(line);
        if (*s == '\0')
            continue;
        char *eq = strchr(s, '=');
        if (eq == NULL) {
            snprintf(err, errlen, "%s:%d: expected key = value", path, lineno);
            fclose(f);
            return -1;
        }
        *eq = '\0';
        char msg[256];
        if (config_set(c, trim(s), trim(eq + 1), msg, sizeof msg) != 0) {
            snprintf(err, errlen, "%s:%d: %s", path, lineno, msg);
            fclose(f);
            return -1;
        }
    }
    fclose(f);
    return config_validate(c, err, errlen);
}
