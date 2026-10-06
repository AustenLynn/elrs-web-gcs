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
}

static void enter_failsafe(safety_t *s, fs_reason_t reason)
{
    if (s->state == SAFETY_FAILSAFE)
        return;
    s->state = SAFETY_FAILSAFE;
    s->fs_reason = reason;
    s->out.failsafe = true;
    s->out.roll = s->out.pitch = s->out.yaw = 0;
    s->out.throttle = 0;
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
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_SESSION_CHANGED);
    s->session = session;
    s->last_seq = 0;
    s->have_cmd = false;
}

bool safety_control(safety_t *s, uint32_t session, uint32_t seq, const stick_cmd_t *cmd, int64_t now)
{
    if (session == 0 || session != s->session || seq <= s->last_seq)
        return false;
    s->last_seq = seq;
    s->have_cmd = true;
    s->last_cmd_ns = now;
    s->cmd.roll = (int16_t)clampi(cmd->roll, -1000, 1000);
    s->cmd.pitch = (int16_t)clampi(cmd->pitch, -1000, 1000);
    s->cmd.yaw = (int16_t)clampi(cmd->yaw, -1000, 1000);
    s->cmd.throttle = (uint16_t)clampi(cmd->throttle, 0, 1000);
    s->cmd.mode = (uint8_t)clampi(cmd->mode, 0, 2);
    if (s->state != SAFETY_FAILSAFE)
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
    s->state = SAFETY_ARMED;
    s->out.arm = true;
    return REFUSE_NONE;
}

void safety_disarm(safety_t *s)
{
    s->out.arm = false;
    if (s->state == SAFETY_ARMED)
        s->state = SAFETY_DISARMED;
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

void safety_pilot_lost(safety_t *s, uint32_t session)
{
    if (session == 0 || session != s->session)
        return;
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_PILOT_LOST);
    s->session = 0;            /* late messages from that session are ignored */
    s->have_cmd = false;
}

void safety_gateway_lost(safety_t *s)
{
    if (s->state == SAFETY_ARMED)
        enter_failsafe(s, FS_GATEWAY_LOST);
    s->session = 0;
    s->have_cmd = false;
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

void safety_tick(safety_t *s, int64_t now)
{
    if (s->state == SAFETY_ARMED && !safety_link_fresh(s, now))
        enter_failsafe(s, FS_CMD_TIMEOUT);
}

const char *safety_state_name(safety_state_t st)
{
    switch (st) {
    case SAFETY_DISARMED: return "DISARMED";
    case SAFETY_ARMED: return "ARMED";
    case SAFETY_FAILSAFE: return "FAILSAFE";
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
    }
    return "?";
}
