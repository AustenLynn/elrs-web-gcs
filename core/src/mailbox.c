#include "mailbox.h"

#include <stdio.h>
#include <string.h>

int mailbox_init(mailbox_t *m)
{
    memset(m, 0, sizeof *m);
    pthread_mutexattr_t attr;
    if (pthread_mutexattr_init(&attr) != 0)
        return -1;
    /* Priority inheritance: if the IPC thread holds the lock when the real-time loop
     * wants it, the IPC thread briefly runs at the loop's priority. */
    if (pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT) != 0 ||
        pthread_mutex_init(&m->mu, &attr) != 0) {
        pthread_mutexattr_destroy(&attr);
        return -1;
    }
    pthread_mutexattr_destroy(&attr);
    return 0;
}

void mailbox_destroy(mailbox_t *m)
{
    pthread_mutex_destroy(&m->mu);
}

bool mailbox_push_cmd(mailbox_t *m, const core_cmd_t *c)
{
    bool ok;
    pthread_mutex_lock(&m->mu);
    ok = m->cmd_w - m->cmd_r < MB_CMD_CAP;
    if (ok)
        m->cmds[m->cmd_w++ % MB_CMD_CAP] = *c;
    else
        m->cmd_dropped++;
    pthread_mutex_unlock(&m->mu);
    return ok;
}

size_t mailbox_take_cmds(mailbox_t *m, core_cmd_t *out, size_t max)
{
    size_t n = 0;
    pthread_mutex_lock(&m->mu);
    while (n < max && m->cmd_r != m->cmd_w)
        out[n++] = m->cmds[m->cmd_r++ % MB_CMD_CAP];
    pthread_mutex_unlock(&m->mu);
    return n;
}

void mailbox_push_event(mailbox_t *m, const core_event_t *e)
{
    pthread_mutex_lock(&m->mu);
    if (m->ev_w - m->ev_r < MB_EVENT_CAP)
        m->events[m->ev_w++ % MB_EVENT_CAP] = *e;
    else
        m->ev_dropped++;
    pthread_mutex_unlock(&m->mu);
}

size_t mailbox_take_events(mailbox_t *m, core_event_t *out, size_t max)
{
    size_t n = 0;
    pthread_mutex_lock(&m->mu);
    while (n < max && m->ev_r != m->ev_w)
        out[n++] = m->events[m->ev_r++ % MB_EVENT_CAP];
    pthread_mutex_unlock(&m->mu);
    return n;
}

void mailbox_push_timing(mailbox_t *m, const timing_sample_t *t)
{
    pthread_mutex_lock(&m->mu);
    if (m->tm_w - m->tm_r < MB_TIMING_CAP)
        m->timing[m->tm_w++ % MB_TIMING_CAP] = *t;
    else
        m->tm_dropped++;
    pthread_mutex_unlock(&m->mu);
}

size_t mailbox_take_timing(mailbox_t *m, timing_sample_t *out, size_t max)
{
    size_t n = 0;
    pthread_mutex_lock(&m->mu);
    while (n < max && m->tm_r != m->tm_w)
        out[n++] = m->timing[m->tm_r++ % MB_TIMING_CAP];
    pthread_mutex_unlock(&m->mu);
    return n;
}

void mailbox_put_status(mailbox_t *m, const ipc_status_t *s)
{
    pthread_mutex_lock(&m->mu);
    uint32_t late = m->status.wake_late_max_us;
    m->status = *s;
    if (late > s->wake_late_max_us)
        m->status.wake_late_max_us = late;
    pthread_mutex_unlock(&m->mu);
}

void mailbox_take_status(mailbox_t *m, ipc_status_t *out)
{
    pthread_mutex_lock(&m->mu);
    *out = m->status;
    m->status.wake_late_max_us = 0;
    pthread_mutex_unlock(&m->mu);
}

void mailbox_put_link(mailbox_t *m, const crsf_link_stats_t *l)
{
    pthread_mutex_lock(&m->mu);
    m->link = *l;
    m->dirty |= MB_DIRTY_LINK;
    pthread_mutex_unlock(&m->mu);
}

void mailbox_put_battery(mailbox_t *m, const crsf_battery_t *b)
{
    pthread_mutex_lock(&m->mu);
    m->battery = *b;
    m->dirty |= MB_DIRTY_BATTERY;
    pthread_mutex_unlock(&m->mu);
}

void mailbox_put_flight_mode(mailbox_t *m, const char *mode)
{
    pthread_mutex_lock(&m->mu);
    snprintf(m->flight_mode, sizeof m->flight_mode, "%s", mode);
    m->dirty |= MB_DIRTY_FMODE;
    pthread_mutex_unlock(&m->mu);
}

void mailbox_put_device(mailbox_t *m, const crsf_device_info_t *d)
{
    pthread_mutex_lock(&m->mu);
    m->device = *d;
    m->dirty |= MB_DIRTY_DEVICE;
    pthread_mutex_unlock(&m->mu);
}

unsigned mailbox_take_telemetry(mailbox_t *m, crsf_link_stats_t *l, crsf_battery_t *b,
                                char fm[16], crsf_device_info_t *d)
{
    pthread_mutex_lock(&m->mu);
    unsigned dirty = m->dirty;
    if (dirty & MB_DIRTY_LINK)
        *l = m->link;
    if (dirty & MB_DIRTY_BATTERY)
        *b = m->battery;
    if (dirty & MB_DIRTY_FMODE)
        memcpy(fm, m->flight_mode, sizeof m->flight_mode);
    if (dirty & MB_DIRTY_DEVICE)
        *d = m->device;
    m->dirty = 0;
    pthread_mutex_unlock(&m->mu);
    return dirty;
}
