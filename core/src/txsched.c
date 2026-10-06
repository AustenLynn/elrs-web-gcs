#include "txsched.h"

static int64_t clamp64(int64_t v, int64_t lo, int64_t hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

void txsched_init(txsched_t *s, int64_t now_ns, int64_t period_ns, int64_t margin_ns)
{
    s->period_ns = clamp64(period_ns, TXSCHED_MIN_PERIOD_NS, TXSCHED_MAX_PERIOD_NS);
    s->next_ns = now_ns + s->period_ns;
    s->margin_ns = margin_ns;
    s->pending_shift_ns = 0;
    s->last_shift_ns = 0;
    s->timing_frames = 0;
}

void txsched_on_timing(txsched_t *s, uint32_t interval_0p1us, int32_t offset_0p1us)
{
    s->period_ns = clamp64((int64_t)interval_0p1us * 100, TXSCHED_MIN_PERIOD_NS, TXSCHED_MAX_PERIOD_NS);
    int64_t shift = (int64_t)offset_0p1us * 100 - s->margin_ns;
    s->pending_shift_ns = clamp64(shift, -s->period_ns / 2, s->period_ns / 2);
    s->timing_frames++;
}

int64_t txsched_advance(txsched_t *s, int64_t now_ns)
{
    s->next_ns += s->period_ns + s->pending_shift_ns;
    s->last_shift_ns = s->pending_shift_ns;
    s->pending_shift_ns = 0;
    if (s->next_ns <= now_ns) {
        int64_t missed = (now_ns - s->next_ns) / s->period_ns + 1;
        s->next_ns += missed * s->period_ns;
    }
    return s->next_ns;
}
