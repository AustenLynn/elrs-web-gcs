#include "ipc_proto.h"

#include <string.h>

typedef struct {
    uint8_t *p;
    size_t cap;
    size_t len;
    bool overflow;
} wbuf_t;

typedef struct {
    const uint8_t *p;
    size_t len;
    size_t pos;
} rbuf_t;

static void put_u8(wbuf_t *w, uint8_t v)
{
    if (w->len + 1 > w->cap) {
        w->overflow = true;
        return;
    }
    w->p[w->len++] = v;
}

static void put_u16(wbuf_t *w, uint16_t v)
{
    put_u8(w, (uint8_t)(v & 0xFF));
    put_u8(w, (uint8_t)(v >> 8));
}

static void put_u32(wbuf_t *w, uint32_t v)
{
    put_u16(w, (uint16_t)(v & 0xFFFF));
    put_u16(w, (uint16_t)(v >> 16));
}

static void put_str(wbuf_t *w, const char *s, size_t max)
{
    size_t n = strnlen(s, max);
    put_u8(w, (uint8_t)n);
    for (size_t i = 0; i < n; i++)
        put_u8(w, (uint8_t)s[i]);
}

static uint8_t get_u8(rbuf_t *r)
{
    return r->p[r->pos++];
}

static uint16_t get_u16(rbuf_t *r)
{
    uint16_t lo = get_u8(r);
    return (uint16_t)(lo | (uint16_t)get_u8(r) << 8);
}

static uint32_t get_u32(rbuf_t *r)
{
    uint32_t lo = get_u16(r);
    return lo | (uint32_t)get_u16(r) << 16;
}

/* Starts a message: reserves the length field and writes the type. */
static wbuf_t begin(uint8_t *out, size_t cap, uint8_t type)
{
    wbuf_t w = { .p = out, .cap = cap };
    put_u16(&w, 0);
    put_u8(&w, type);
    return w;
}

static size_t finish(wbuf_t *w)
{
    if (w->overflow || w->len - 2 > IPC_MAX_MSG)
        return 0;
    uint16_t body = (uint16_t)(w->len - 2);
    w->p[0] = (uint8_t)(body & 0xFF);
    w->p[1] = (uint8_t)(body >> 8);
    return w->len;
}

void ipc_reader_init(ipc_reader_t *r)
{
    r->len = 0;
}

int ipc_reader_feed(ipc_reader_t *r, const uint8_t *data, size_t n, ipc_msg_cb cb, void *user)
{
    for (size_t i = 0; i < n; i++) {
        r->buf[r->len++] = data[i];
        if (r->len < 2)
            continue;
        size_t body = (size_t)r->buf[0] | (size_t)r->buf[1] << 8;
        if (body < 1 || body > IPC_MAX_MSG)
            return -1;
        if (r->len == 2 + body) {
            cb(r->buf[2], r->buf + 3, body - 1, user);
            r->len = 0;
        }
    }
    return 0;
}

size_t ipc_encode_session_msg(uint8_t *out, size_t cap, uint8_t type, uint32_t session)
{
    wbuf_t w = begin(out, cap, type);
    put_u32(&w, session);
    return finish(&w);
}

size_t ipc_encode_control(uint8_t *out, size_t cap, const ipc_control_t *c)
{
    wbuf_t w = begin(out, cap, IPC_CONTROL);
    put_u32(&w, c->session);
    put_u32(&w, c->seq);
    put_u16(&w, (uint16_t)c->sticks.roll);
    put_u16(&w, (uint16_t)c->sticks.pitch);
    put_u16(&w, (uint16_t)c->sticks.yaw);
    put_u16(&w, c->sticks.throttle);
    put_u8(&w, c->sticks.mode);
    return finish(&w);
}

size_t ipc_encode_status(uint8_t *out, size_t cap, const ipc_status_t *s)
{
    wbuf_t w = begin(out, cap, IPC_STATUS);
    put_u8(&w, s->state);
    put_u8(&w, s->fs_reason);
    put_u8(&w, s->fc_arm);
    put_u8(&w, s->serial_ok);
    put_u32(&w, s->session);
    put_u32(&w, s->last_seq);
    put_u32(&w, s->cmd_age_ms);
    put_u32(&w, s->frames_sent);
    put_u32(&w, s->tx_errors);
    put_u32(&w, s->rx_frames);
    put_u32(&w, s->rx_crc_errors);
    put_u32(&w, s->period_us);
    put_u32(&w, (uint32_t)s->offset_0p1us);
    put_u32(&w, s->timing_frames);
    put_u32(&w, s->wake_late_max_us);
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        put_u16(&w, s->channels[i]);
    return finish(&w);
}

size_t ipc_encode_link(uint8_t *out, size_t cap, const crsf_link_stats_t *l)
{
    wbuf_t w = begin(out, cap, IPC_LINK);
    put_u8(&w, (uint8_t)l->up_rssi1);
    put_u8(&w, (uint8_t)l->up_rssi2);
    put_u8(&w, l->up_lq);
    put_u8(&w, (uint8_t)l->up_snr);
    put_u8(&w, l->antenna);
    put_u8(&w, l->rf_mode);
    put_u16(&w, l->tx_power_mw);
    put_u8(&w, (uint8_t)l->dn_rssi);
    put_u8(&w, l->dn_lq);
    put_u8(&w, (uint8_t)l->dn_snr);
    return finish(&w);
}

size_t ipc_encode_battery(uint8_t *out, size_t cap, const crsf_battery_t *b)
{
    wbuf_t w = begin(out, cap, IPC_BATTERY);
    put_u16(&w, b->voltage_dv);
    put_u16(&w, b->current_da);
    put_u32(&w, b->capacity_mah);
    put_u8(&w, b->remaining_pct);
    return finish(&w);
}

size_t ipc_encode_flight_mode(uint8_t *out, size_t cap, const char *mode)
{
    wbuf_t w = begin(out, cap, IPC_FLIGHT_MODE);
    put_str(&w, mode, 15);
    return finish(&w);
}

size_t ipc_encode_device(uint8_t *out, size_t cap, const crsf_device_info_t *d)
{
    wbuf_t w = begin(out, cap, IPC_DEVICE);
    put_u8(&w, d->origin);
    put_u8(&w, d->sw_major);
    put_u8(&w, d->sw_minor);
    put_u8(&w, d->sw_patch);
    put_u32(&w, d->serial);
    put_str(&w, d->name, 31);
    return finish(&w);
}

size_t ipc_encode_event(uint8_t *out, size_t cap, uint8_t kind, uint8_t detail, uint32_t session)
{
    wbuf_t w = begin(out, cap, IPC_EVENT);
    put_u8(&w, kind);
    put_u8(&w, detail);
    put_u32(&w, session);
    return finish(&w);
}

int ipc_decode_session_msg(const uint8_t *p, size_t n, uint32_t *session)
{
    if (n != 4)
        return -1;
    rbuf_t r = { .p = p, .len = n };
    *session = get_u32(&r);
    return 0;
}

int ipc_decode_control(const uint8_t *p, size_t n, ipc_control_t *c)
{
    if (n != 17)
        return -1;
    rbuf_t r = { .p = p, .len = n };
    c->session = get_u32(&r);
    c->seq = get_u32(&r);
    c->sticks.roll = (int16_t)get_u16(&r);
    c->sticks.pitch = (int16_t)get_u16(&r);
    c->sticks.yaw = (int16_t)get_u16(&r);
    c->sticks.throttle = get_u16(&r);
    c->sticks.mode = get_u8(&r);
    return 0;
}

int ipc_decode_status(const uint8_t *p, size_t n, ipc_status_t *s)
{
    if (n != IPC_STATUS_LEN)
        return -1;
    rbuf_t r = { .p = p, .len = n };
    s->state = get_u8(&r);
    s->fs_reason = get_u8(&r);
    s->fc_arm = get_u8(&r);
    s->serial_ok = get_u8(&r);
    s->session = get_u32(&r);
    s->last_seq = get_u32(&r);
    s->cmd_age_ms = get_u32(&r);
    s->frames_sent = get_u32(&r);
    s->tx_errors = get_u32(&r);
    s->rx_frames = get_u32(&r);
    s->rx_crc_errors = get_u32(&r);
    s->period_us = get_u32(&r);
    s->offset_0p1us = (int32_t)get_u32(&r);
    s->timing_frames = get_u32(&r);
    s->wake_late_max_us = get_u32(&r);
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        s->channels[i] = get_u16(&r);
    return 0;
}
