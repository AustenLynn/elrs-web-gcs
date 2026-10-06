#include "evlog.h"

#include <errno.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static void copy_safe(char *dst, size_t cap, const char *src)
{
    /* Strings come from the aircraft: keep printable ASCII only, no quotes or backslashes. */
    size_t n = 0;
    for (; src[n] != '\0' && n + 1 < cap; n++) {
        unsigned char ch = (unsigned char)src[n];
        dst[n] = (ch >= 0x20 && ch < 0x7F && ch != '"' && ch != '\\') ? (char)ch : '?';
    }
    dst[n] = '\0';
}

static const char *cmd_name(int kind)
{
    return kind == CMD_ARM ? "arm" : kind == CMD_ACK ? "ack" : "?";
}

size_t evlog_format(char *out, size_t cap, const core_event_t *ev, const char *wall)
{
    char text[sizeof ev->text];
    copy_safe(text, sizeof text, ev->text);
    int n = snprintf(out, cap, "{\"t_ns\":%lld,\"wall\":\"%s\",", (long long)ev->t_ns, wall);
    if (n < 0 || (size_t)n >= cap)
        return 0;
    char *p = out + n;
    size_t left = cap - (size_t)n;
    int m;

    switch (ev->kind) {
    case EV_STATE:
        m = snprintf(p, left, "\"ev\":\"state\",\"from\":\"%s\",\"to\":\"%s\",\"reason\":\"%s\","
                     "\"session\":%u,\"cmd_age_ms\":%d}",
                     safety_state_name((safety_state_t)ev->a), safety_state_name((safety_state_t)ev->b),
                     safety_reason_name((fs_reason_t)ev->c), ev->session, ev->cmd_age_ms);
        break;
    case EV_REFUSED:
        m = snprintf(p, left, "\"ev\":\"refused\",\"what\":\"%s\",\"reason\":\"%s\",\"session\":%u}",
                     cmd_name(ev->a), safety_refuse_name((refuse_t)ev->b), ev->session);
        break;
    case EV_FLIGHT_MODE:
        m = snprintf(p, left, "\"ev\":\"flight_mode\",\"mode\":\"%s\"}", text);
        break;
    case EV_SERIAL:
        m = snprintf(p, left, "\"ev\":\"serial\",\"ok\":%s}", ev->a ? "true" : "false");
        break;
    case EV_DEVICE:
        m = snprintf(p, left, "\"ev\":\"device\",\"name\":\"%s\",\"origin\":%d,\"version\":\"%d.%d.%d\"}",
                     text, ev->a, ev->b, ev->c, ev->d);
        break;
    case EV_TIMING:
        m = snprintf(p, left, "\"ev\":\"timing\",\"interval_us\":%.1f,\"offset_us\":%.1f}",
                     ev->a / 10.0, ev->b / 10.0);
        break;
    case EV_GATEWAY:
        m = snprintf(p, left, "\"ev\":\"gateway\",\"connected\":%s}", ev->a ? "true" : "false");
        break;
    case EV_START:
        m = snprintf(p, left, "\"ev\":\"start\",\"version\":\"%s\"}", text);
        break;
    default:
        m = snprintf(p, left, "\"ev\":\"unknown\"}");
        break;
    }
    if (m < 0 || (size_t)m >= left)
        return 0;
    return (size_t)n + (size_t)m;
}

static void wall_now(char *out, size_t cap)
{
    struct timeval tv;
    struct tm tm;
    gettimeofday(&tv, NULL);
    gmtime_r(&tv.tv_sec, &tm);
    size_t n = strftime(out, cap, "%Y-%m-%dT%H:%M:%S", &tm);
    snprintf(out + n, cap - n, ".%03ldZ", (long)(tv.tv_usec / 1000));
}

int evlog_open(evlog_t *e, const char *events_path, const char *timing_path, char *err, size_t errlen)
{
    e->events = NULL;
    e->timing = NULL;
    if (events_path[0] != '\0' && (e->events = fopen(events_path, "a")) == NULL) {
        snprintf(err, errlen, "%s: %s", events_path, strerror(errno));
        return -1;
    }
    if (timing_path[0] != '\0') {
        if ((e->timing = fopen(timing_path, "a")) == NULL) {
            snprintf(err, errlen, "%s: %s", timing_path, strerror(errno));
            evlog_close(e);
            return -1;
        }
        if (ftell(e->timing) == 0)
            fprintf(e->timing, "deadline_ns,wake_ns,write_start_ns,write_end_ns,period_ns,shift_ns\n");
    }
    return 0;
}

void evlog_event(evlog_t *e, const core_event_t *ev)
{
    char wall[40], line[512];
    wall_now(wall, sizeof wall);
    if (evlog_format(line, sizeof line, ev, wall) == 0)
        return;
    if (e->events != NULL)
        fprintf(e->events, "%s\n", line);
    if (ev->kind != EV_TIMING)
        fprintf(stderr, "crsf-core: %s\n", line);
}

void evlog_timing(evlog_t *e, const timing_sample_t *t)
{
    if (e->timing == NULL)
        return;
    fprintf(e->timing, "%lld,%lld,%lld,%lld,%lld,%lld\n", (long long)t->deadline_ns,
            (long long)t->wake_ns, (long long)t->write_start_ns, (long long)t->write_end_ns,
            (long long)t->period_ns, (long long)t->shift_ns);
}

void evlog_flush(evlog_t *e)
{
    if (e->events != NULL)
        fflush(e->events);
    if (e->timing != NULL)
        fflush(e->timing);
    fflush(stderr);
}

void evlog_close(evlog_t *e)
{
    if (e->events != NULL)
        fclose(e->events);
    if (e->timing != NULL)
        fclose(e->timing);
    e->events = NULL;
    e->timing = NULL;
}
