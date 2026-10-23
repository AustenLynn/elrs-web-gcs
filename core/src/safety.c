#include "safety.h"

#include <string.h>

static int clampi(int v, int lo, int hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

static void apply_sticks(safety_t *s)
{
    s->out.roll = s->cmd.roll;
    s->out.pitch = s->cmd.pitch;
    s->out.yaw = s->cmd.yaw;
    s->out.throttle = s->cmd.throttle;
    s->out.mode = s->cmd.mode;
    s->out.speed = s->cmd.speed;
    s->out.turtle = s->cmd.turtle;
}

static bool in_flight(const safety_t *s)
{
    return s->state == SAFETY_ARMED || s->state == SAFETY_HOLD || s->state == SAFETY_LANDING;
}

static void report(safety_t *s, hold_ev_t ev)
{
    if (s->report_count == SAFETY_REPORT_CAP)
        return;                /* full: the newest is dropped */
    hold_report_t *r = &s->reports[(s->report_head + s->report_count) % SAFETY_REPORT_CAP];
    r->ev = ev;
    r->reason = s->hold_reason;
    r->session = s->session;
    s->report_count++;
}

/* Clears the hold. A seat lost during it (pilot_lost) is cleared too: late messages from
 * that session stay ignored. */
static void leave_hold(safety_t *s)
{
    if (s->seat_lost) {
        s->session = 0;
        s->have_cmd = false;
        s->cmd.turtle = false;
    }
    s->stage_end_ns = 0;
    s->hold_reason = FS_NONE;
    s->resume_session = 0;
    s->seat_lost = false;
    s->take_pending = false;
}

/* HOLD and LANDING outputs: ARM unchanged (high), sticks centred, flight mode Normal (holds
 * height), turtle off, speed kept. */
static void hold_outputs(safety_t *s, uint16_t throttle)
{
    s->out.roll = s->out.pitch = s->out.yaw = 0;
    s->out.throttle = throttle;
    s->out.mode = 0;
    s->out.turtle = false;
}

static void enter_landing(safety_t *s, int64_t now)
{
    s->state = SAFETY_LANDING;
    s->resume_session = 0;
    s->stage_end_ns = now + s->land_ns;
    hold_outputs(s, 0);
    report(s, HOLD_EV_LANDING);
}

/* Lost the pilot while ARMED with the hold enabled. */
static void enter_hold(safety_t *s, fs_reason_t why, int64_t now)
{
    s->hold_reason = why;
    s->resume_session = why == FS_CMD_TIMEOUT ? s->session : 0;
    s->seat_lost = why == FS_PILOT_LOST;
    s->take_pending = false;
    if (s->cmd.throttle <= s->throttle_arm_max) {
        enter_landing(s, now);     /* maybe on the ground: hold_throttle would lift it */
        return;
    }
    s->state = SAFETY_HOLD;
    s->stage_end_ns = now + s->hold_ns;
    hold_outputs(s, s->hold_throttle);
    report(s, HOLD_EV_HOLD);
}

static void enter_failsafe(safety_t *s, fs_reason_t reason)
{
    if (s->state == SAFETY_FAILSAFE)
        return;
    leave_hold(s);
    s->state = SAFETY_FAILSAFE;
    s->fs_reason = reason;
    s->out.failsafe = true;
    s->out.roll = s->out.pitch = s->out.yaw = 0;
    s->out.throttle = 0;
    s->out.turtle = false;     /* speed is kept: it only changes how the drone responds */
    /* out.arm unchanged: Betaflight decides what happens next (drop, land, rescue). */
}

void safety_init(safety_t *s, int64_t timeout_ns, int64_t fc_fresh_ns, uint16_t throttle_arm_max)
{
    memset(s, 0, sizeof *s);
    s->timeout_ns = timeout_ns;
    s->fc_fresh_ns = fc_fresh_ns;
    s->throttle_arm_max = throttle_arm_max;
    s->state = SAFETY_DISARMED;
}

bool safety_link_fresh(const safety_t *s, int64_t now)
{
    return s->have_cmd && now - s->last_cmd_ns <= s->timeout_ns;
}

void safety_session_start(safety_t *s, uint32_t session)
{
    if (in_flight(s))
        enter_failsafe(s, FS_SESSION_CHANGED);
    s->session = session;
    s->last_seq = 0;
    s->have_cmd = false;
    s->standby = 0;
}

bool safety_control(safety_t *s, uint32_t session, uint32_t seq, const stick_cmd_t *cmd, int64_t now)
{
    if (session == 0 || session != s->session || seq <= s->last_seq || s->seat_lost)
        return false;
    s->last_seq = seq;
    s->have_cmd = true;
    s->last_cmd_ns = now;
    s->cmd.roll = (int16_t)clampi(cmd->roll, -1000, 1000);
    s->cmd.pitch = (int16_t)clampi(cmd->pitch, -1000, 1000);
    s->cmd.yaw = (int16_t)clampi(cmd->yaw, -1000, 1000);
    s->cmd.throttle = (uint16_t)clampi(cmd->throttle, 0, 1000);
    s->cmd.mode = (uint8_t)clampi(cmd->mode, 0, 2);
    s->cmd.speed = (uint8_t)clampi(cmd->speed, 0, 2);
    s->cmd.turtle = cmd->turtle;
    /* HOLD: the session that timed out resumes, or the taker's first command. LANDING: only
     * the taker's. Otherwise (FAILSAFE, LANDING) the command is stored, not applied. */
    bool resume = s->state == SAFETY_HOLD && session == s->resume_session;
    bool taken = (s->state == SAFETY_HOLD || s->state == SAFETY_LANDING) && s->take_pending;
    if (resume || taken) {
        if (resume)
            report(s, HOLD_EV_RESUMED);
        s->state = SAFETY_ARMED;
        leave_hold(s);
    }
    if (s->state == SAFETY_DISARMED || s->state == SAFETY_ARMED)
        apply_sticks(s);
    return true;
}

refuse_t safety_arm(safety_t *s, uint32_t session, int64_t now)
{
    if (session == 0 || session != s->session)
        return REFUSE_WRONG_SESSION;
    if (s->state != SAFETY_DISARMED)
        return REFUSE_NOT_DISARMED;
    if (!safety_link_fresh(s, now))
        return REFUSE_LINK_STALE;
    if (s->cmd.throttle > s->throttle_arm_max)
        return REFUSE_THROTTLE_HIGH;
    if (s->rf_timeout_ns > 0 && now - s->rf_ok_ns > s->rf_timeout_ns)
        return REFUSE_RF_DOWN;     /* armed now, it would fail safe (rf_lost) on the next tick */
    s->state = SAFETY_ARMED;
    s->out.arm = true;
    return REFUSE_NONE;
}

void safety_disarm(safety_t *s, uint32_t session)
{
    if (session == 0 || session != s->session)
        return;
    s->out.arm = false;
    if (in_flight(s)) {
        s->state = SAFETY_DISARMED;
        leave_hold(s);
    }
}

void safety_manual_failsafe(safety_t *s, uint32_t session)
{
    if (session == 0 || session != s->session)
        return;
    enter_failsafe(s, FS_MANUAL);
}

refuse_t safety_ack(safety_t *s, uint32_t session, int64_t now)
{
    if (session == 0 || session != s->session)
        return REFUSE_WRONG_SESSION;
    if (s->state != SAFETY_FAILSAFE)
        return REFUSE_NOT_IN_FAILSAFE;
    if (!safety_link_fresh(s, now))
        return REFUSE_LINK_STALE;
    if (s->cmd.throttle > s->throttle_arm_max)
        return REFUSE_THROTTLE_HIGH;
    if (s->fc_arm == FC_ARMED && now - s->fc_arm_ns <= s->fc_fresh_ns)
        return REFUSE_FC_STILL_ARMED;
    s->state = SAFETY_DISARMED;
    s->fs_reason = FS_NONE;
    s->out.failsafe = false;
    s->out.arm = false;
    apply_sticks(s);
    return REFUSE_NONE;
}

void safety_pilot_lost(safety_t *s, uint32_t session, int64_t now)
{
    if (session == 0 || session != s->session)
        return;
    if (s->state == SAFETY_HOLD || s->state == SAFETY_LANDING) {
        s->seat_lost = true;   /* no resume; the countdown runs on */
        s->resume_session = 0;
        s->take_pending = false;
        return;
    }
    if (s->state == SAFETY_ARMED && s->hold_ns > 0) {
        enter_hold(s, FS_PILOT_LOST, now);
        return;
    }
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_PILOT_LOST);
    s->session = 0;            /* late messages from that session are ignored */
    s->have_cmd = false;
    s->cmd.turtle = s->out.turtle = false;   /* nobody in control: not even disarmed */
}

void safety_gateway_lost(safety_t *s)
{
    if (in_flight(s))
        enter_failsafe(s, FS_GATEWAY_LOST);
    s->session = 0;
    s->have_cmd = false;
    s->standby = 0;
    s->cmd.turtle = s->out.turtle = false;
}

void safety_set_standby(safety_t *s, uint32_t session)
{
    if (session != 0 && session == s->session)
        return;
    s->standby = session;
}

void safety_set_hold(safety_t *s, int64_t hold_ns, int64_t land_ns, uint16_t hold_throttle)
{
    s->hold_ns = hold_ns;
    s->land_ns = land_ns;
    s->hold_throttle = hold_throttle;
}

refuse_t safety_take(safety_t *s, uint32_t session, int64_t now)
{
    (void)now;                 /* the countdown runs on: no fresh timer for the taker */
    if (session == 0 || session != s->standby)
        return REFUSE_NOT_STANDBY;
    if (s->state != SAFETY_HOLD && s->state != SAFETY_LANDING)
        return REFUSE_NOT_IN_HOLD;
    s->session = session;
    s->standby = 0;
    s->last_seq = 0;
    s->have_cmd = false;       /* the last command is the old pilot's */
    s->resume_session = 0;
    s->seat_lost = false;
    s->take_pending = true;
    report(s, HOLD_EV_TAKEN);
    return REFUSE_NONE;
}

refuse_t safety_land(safety_t *s, uint32_t session, int64_t now)
{
    if (session == 0 || session != s->standby)
        return REFUSE_NOT_STANDBY;
    if (s->state != SAFETY_HOLD)
        return REFUSE_NOT_IN_HOLD;
    enter_landing(s, now);
    return REFUSE_NONE;
}

bool safety_take_report(safety_t *s, hold_ev_t *ev, fs_reason_t *reason, uint32_t *session)
{
    if (s->report_count == 0)
        return false;
    const hold_report_t *r = &s->reports[s->report_head];
    *ev = r->ev;
    *reason = r->reason;
    *session = r->session;
    s->report_head = (uint8_t)((s->report_head + 1) % SAFETY_REPORT_CAP);
    s->report_count--;
    return true;
}

uint32_t safety_stage_left_ms(const safety_t *s, int64_t now)
{
    if (s->state != SAFETY_HOLD && s->state != SAFETY_LANDING)
        return 0;
    int64_t left = s->stage_end_ns - now;
    if (left <= 0)
        return 0;
    int64_t ms = (left + 999999) / 1000000;
    return ms > UINT32_MAX ? UINT32_MAX : (uint32_t)ms;
}

void safety_trigger(safety_t *s, fs_reason_t reason)
{
    enter_failsafe(s, reason);
}

void safety_fc_flight_mode(safety_t *s, const char *mode, int64_t now)
{
    size_t n = strlen(mode);
    s->fc_arm = n == 0 ? FC_UNKNOWN : mode[n - 1] == '*' ? FC_DISARMED : FC_ARMED;
    s->fc_arm_ns = now;
}

void safety_set_rf_timeout(safety_t *s, int64_t timeout_ns)
{
    s->rf_timeout_ns = timeout_ns;
}

void safety_rf_link(safety_t *s, bool linked, int64_t now)
{
    if (linked)
        s->rf_ok_ns = now;
}

void safety_tick(safety_t *s, int64_t now)
{
    if (in_flight(s) && s->rf_timeout_ns > 0 && now - s->rf_ok_ns > s->rf_timeout_ns)
        enter_failsafe(s, FS_RF_LOST);
    else if (s->state == SAFETY_ARMED && !safety_link_fresh(s, now)) {
        if (s->hold_ns > 0)
            enter_hold(s, FS_CMD_TIMEOUT, now);
        else
            enter_failsafe(s, FS_CMD_TIMEOUT);
    } else if (s->state == SAFETY_HOLD && now >= s->stage_end_ns)
        enter_landing(s, now);
    else if (s->state == SAFETY_LANDING && now >= s->stage_end_ns)
        enter_failsafe(s, s->hold_reason);     /* clears a lost seat */
}

const char *safety_state_name(safety_state_t st)
{
    switch (st) {
    case SAFETY_DISARMED: return "DISARMED";
    case SAFETY_ARMED: return "ARMED";
    case SAFETY_FAILSAFE: return "FAILSAFE";
    case SAFETY_HOLD: return "HOLD";
    case SAFETY_LANDING: return "LANDING";
    }
    return "?";
}

const char *safety_reason_name(fs_reason_t r)
{
    switch (r) {
    case FS_NONE: return "none";
    case FS_CMD_TIMEOUT: return "cmd_timeout";
    case FS_PILOT_LOST: return "pilot_lost";
    case FS_GATEWAY_LOST: return "gateway_lost";
    case FS_SESSION_CHANGED: return "session_changed";
    case FS_MANUAL: return "manual";
    case FS_RF_LOST: return "rf_lost";
    }
    return "?";
}

const char *safety_refuse_name(refuse_t r)
{
    switch (r) {
    case REFUSE_NONE: return "none";
    case REFUSE_WRONG_SESSION: return "wrong_session";
    case REFUSE_NOT_DISARMED: return "not_disarmed";
    case REFUSE_NOT_IN_FAILSAFE: return "not_in_failsafe";
    case REFUSE_LINK_STALE: return "link_stale";
    case REFUSE_THROTTLE_HIGH: return "throttle_high";
    case REFUSE_FC_STILL_ARMED: return "fc_still_armed";
    case REFUSE_RF_DOWN: return "rf_down";
    case REFUSE_NOT_STANDBY: return "not_standby";
    case REFUSE_NOT_IN_HOLD: return "not_in_hold";
    }
    return "?";
}

const char *safety_hold_ev_name(hold_ev_t e)
{
    switch (e) {
    case HOLD_EV_HOLD: return "hold";
    case HOLD_EV_RESUMED: return "resumed";
    case HOLD_EV_TAKEN: return "taken";
    case HOLD_EV_LANDING: return "landing";
    }
    return "?";
}
