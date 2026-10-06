#include "check.h"
#include "txsched.h"

#define US 1000LL
#define MS 1000000LL

static void test_default_period_until_timing_arrives(void)
{
    txsched_t s;
    txsched_init(&s, 1000 * MS, 4 * MS, 1 * MS);
    CHECK_EQ_INT(s.next_ns, 1004 * MS);
    CHECK_EQ_INT(txsched_advance(&s, 1004 * MS), 1008 * MS);
    CHECK_EQ_INT(txsched_advance(&s, 1008 * MS), 1012 * MS);
}

static void test_adopts_interval_and_applies_offset_once(void)
{
    txsched_t s;
    txsched_init(&s, 0, 4 * MS, 0);
    txsched_on_timing(&s, 50000, 2000);           /* 5 ms, +200 us */
    CHECK_EQ_INT(txsched_advance(&s, 4 * MS), 4 * MS + 5 * MS + 200 * US);
    CHECK_EQ_INT(s.last_shift_ns, 200 * US);
    CHECK_EQ_INT(txsched_advance(&s, 9 * MS + 200 * US), 14 * MS + 200 * US);
    CHECK_EQ_INT(s.last_shift_ns, 0);
    CHECK_EQ_INT(s.timing_frames, 1);
}

static void test_margin_moves_frames_earlier(void)
{
    txsched_t s;
    txsched_init(&s, 0, 4 * MS, 1 * MS);
    txsched_on_timing(&s, 40000, 0);              /* module happy; we still aim 1 ms early */
    CHECK_EQ_INT(txsched_advance(&s, 4 * MS), 8 * MS - 1 * MS);
}

static void test_negative_offset(void)
{
    txsched_t s;
    txsched_init(&s, 0, 4 * MS, 0);
    txsched_on_timing(&s, 40000, -12345);         /* -1234.5 us */
    CHECK_EQ_INT(txsched_advance(&s, 4 * MS), 8 * MS - 1234500);
}

static void test_shift_is_clamped_to_half_a_period(void)
{
    txsched_t s;
    txsched_init(&s, 0, 4 * MS, 0);
    txsched_on_timing(&s, 40000, 900000);         /* +90 ms requested */
    CHECK_EQ_INT(txsched_advance(&s, 4 * MS), 4 * MS + 4 * MS + 2 * MS);
    txsched_on_timing(&s, 40000, -900000);
    CHECK_EQ_INT(txsched_advance(&s, 10 * MS), 10 * MS + 4 * MS - 2 * MS);
}

static void test_interval_is_clamped(void)
{
    txsched_t s;
    txsched_init(&s, 0, 4 * MS, 0);
    txsched_on_timing(&s, 1, 0);
    CHECK_EQ_INT(s.period_ns, TXSCHED_MIN_PERIOD_NS);
    txsched_on_timing(&s, 4000000, 0);
    CHECK_EQ_INT(s.period_ns, TXSCHED_MAX_PERIOD_NS);
}

static void test_stall_skips_missed_slots_and_keeps_phase(void)
{
    txsched_t s;
    txsched_init(&s, 0, 4 * MS, 0);               /* slots at 4, 8, 12, ... ms */
    CHECK_EQ_INT(txsched_advance(&s, 4 * MS + 100 * US), 8 * MS);
    /* frame due at 8 ms only went out at 21 ms: next slot on the grid after 21 ms is 24 ms */
    CHECK_EQ_INT(txsched_advance(&s, 21 * MS), 24 * MS);
}

int main(void)
{
    RUN(test_default_period_until_timing_arrives);
    RUN(test_adopts_interval_and_applies_offset_once);
    RUN(test_margin_moves_frames_earlier);
    RUN(test_negative_offset);
    RUN(test_shift_is_clamped_to_half_a_period);
    RUN(test_interval_is_clamped);
    RUN(test_stall_skips_missed_slots_and_keeps_phase);
    return CHECK_EXIT();
}
