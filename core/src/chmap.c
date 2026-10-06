#include "chmap.h"

static int clampi(int v, int lo, int hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

static uint16_t stick(const config_t *c, int v)
{
    v = clampi(v, -1000, 1000);
    int span = c->stick_max_us - c->stick_min_us;
    return crsf_us_to_ch((c->stick_min_us + c->stick_max_us) / 2 + v * span / 2000);
}

static uint16_t sw(const config_t *c, bool on)
{
    return crsf_us_to_ch(on ? c->stick_max_us : c->stick_min_us);
}

void chmap_build(const config_t *c, const rc_outputs_t *o, uint16_t ch[CRSF_NUM_CHANNELS])
{
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = crsf_us_to_ch(c->stick_min_us);

    int span = c->stick_max_us - c->stick_min_us;
    int mode = clampi(o->mode, 0, 2);
    ch[c->ch_roll] = stick(c, o->roll);
    ch[c->ch_pitch] = stick(c, o->pitch);
    ch[c->ch_yaw] = stick(c, o->yaw);
    ch[c->ch_throttle] = crsf_us_to_ch(c->stick_min_us + clampi(o->throttle, 0, 1000) * span / 1000);
    ch[c->ch_mode] = crsf_us_to_ch(c->stick_min_us + mode * span / 2);
    ch[c->ch_arm] = sw(c, o->arm);
    ch[c->ch_failsafe] = sw(c, o->failsafe);
}
