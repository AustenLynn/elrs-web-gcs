#include "crsf_telem.h"
#include <string.h>

static const uint16_t TX_POWER_MW[] = { 0, 10, 25, 100, 500, 1000, 2000, 250, 50 };

static uint16_t be16(const uint8_t *p)
{
    return (uint16_t)((p[0] << 8) | p[1]);
}

static uint32_t be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static crsf_msg_kind_t decode_link_stats(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    if (plen != 10)
        return CRSF_MSG_NONE;
    crsf_link_stats_t *l = &m->u.link;
    l->up_rssi1 = (int8_t)p[0];
    l->up_rssi2 = (int8_t)p[1];
    l->up_lq = p[2];
    l->up_snr = (int8_t)p[3];
    l->antenna = p[4];
    l->rf_mode = p[5];
    l->tx_power_mw = p[6] < sizeof TX_POWER_MW / sizeof TX_POWER_MW[0] ? TX_POWER_MW[p[6]] : 0;
    l->dn_rssi = (int8_t)p[7];
    l->dn_lq = p[8];
    l->dn_snr = (int8_t)p[9];
    return CRSF_MSG_LINK_STATS;
}

static crsf_msg_kind_t decode_battery(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    if (plen != 8)
        return CRSF_MSG_NONE;
    m->u.battery.voltage_dv = be16(p);
    m->u.battery.current_da = be16(p + 2);
    m->u.battery.capacity_mah = ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 8) | p[6];
    m->u.battery.remaining_pct = p[7];
    return CRSF_MSG_BATTERY;
}

static crsf_msg_kind_t decode_flight_mode(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    if (plen < 1)
        return CRSF_MSG_NONE;
    size_t n = 0;
    while (n < plen && n < sizeof m->u.flight_mode.mode - 1 && p[n] != '\0') {
        m->u.flight_mode.mode[n] = (char)p[n];
        n++;
    }
    m->u.flight_mode.mode[n] = '\0';
    return CRSF_MSG_FLIGHT_MODE;
}

static crsf_msg_kind_t decode_radio_id(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    /* p[0] destination, p[1] origin, p[2] sub-type, then two big-endian 32-bit values */
    if (plen != 11 || p[2] != CRSF_RADIO_ID_TIMING)
        return CRSF_MSG_NONE;
    m->u.timing.interval_0p1us = be32(p + 3);
    m->u.timing.offset_0p1us = (int32_t)be32(p + 7);
    return CRSF_MSG_TIMING;
}

static crsf_msg_kind_t decode_device_info(const uint8_t *p, size_t plen, crsf_msg_t *m)
{
    /* p[0] destination, p[1] origin, NUL-terminated name, then 14 bytes of fixed fields */
    if (plen < 2 + 1 + 14)
        return CRSF_MSG_NONE;
    const uint8_t *name = p + 2;
    const uint8_t *nul = memchr(name, '\0', plen - 2);
    if (nul == NULL)
        return CRSF_MSG_NONE;
    size_t name_len = (size_t)(nul - name);
    if (2 + name_len + 1 + 14 > plen)
        return CRSF_MSG_NONE;

    crsf_device_info_t *d = &m->u.device;
    size_t copy = name_len < sizeof d->name - 1 ? name_len : sizeof d->name - 1;
    memcpy(d->name, name, copy);
    d->name[copy] = '\0';
    const uint8_t *q = nul + 1;
    d->origin = p[1];
    d->serial = be32(q);
    /* q[4..7] hardware version, q[8..11] software version (q[8] unused) */
    d->sw_major = q[9];
    d->sw_minor = q[10];
    d->sw_patch = q[11];
    d->field_count = q[12];
    d->param_version = q[13];
    return CRSF_MSG_DEVICE_INFO;
}

crsf_msg_kind_t crsf_decode(const uint8_t *frame, size_t len, crsf_msg_t *out)
{
    memset(out, 0, sizeof *out);
    if (len < 4 || (size_t)frame[1] + 2 != len)
        return CRSF_MSG_NONE;
    const uint8_t *p = frame + 3;   /* payload: after address, length and type */
    size_t plen = len - 4;          /* minus address, length, type and CRC */

    crsf_msg_kind_t kind;
    switch (frame[2]) {
    case CRSF_TYPE_LINK_STATS:  kind = decode_link_stats(p, plen, out); break;
    case CRSF_TYPE_BATTERY:     kind = decode_battery(p, plen, out); break;
    case CRSF_TYPE_FLIGHT_MODE: kind = decode_flight_mode(p, plen, out); break;
    case CRSF_TYPE_RADIO_ID:    kind = decode_radio_id(p, plen, out); break;
    case CRSF_TYPE_DEVICE_INFO: kind = decode_device_info(p, plen, out); break;
    case CRSF_TYPE_RC_CHANNELS:
        if (plen != 22)
            return CRSF_MSG_NONE;
        crsf_unpack_channels(p, out->u.channels);
        kind = CRSF_MSG_RC_CHANNELS;
        break;
    default:
        kind = CRSF_MSG_NONE;
        break;
    }
    out->kind = kind;
    return kind;
}
