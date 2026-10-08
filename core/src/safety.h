/* safety.h - arming and failsafe state machine. Pure logic: callers pass the time in.
 *
 * Rules:
 *  - Nothing upstream is trusted. Armed + no *fresh* command for timeout -> FAILSAFE.
 *    A command is fresh only if it belongs to the current session and its sequence
 *    number is higher than the last one applied.
 *  - FAILSAFE raises the FAILSAFE switch, centres the sticks and drops throttle, and
 *    leaves ARM as it was so Betaflight runs its own failsafe procedure.
 *  - FAILSAFE is latched. Only an explicit acknowledge clears it, and only while the
 *    link is fresh, throttle is low and the FC does not report itself armed. Clearing
 *    always ends DISARMED; flying again needs a new, explicit arm request. */
#ifndef SAFETY_H
#define SAFETY_H

#include <stdbool.h>
#include <stdint.h>
#include "chmap.h"

typedef enum { SAFETY_DISARMED = 0, SAFETY_ARMED = 1, SAFETY_FAILSAFE = 2 } safety_state_t;

typedef enum {
    FS_NONE = 0,
    FS_CMD_TIMEOUT,      /* armed and no fresh command for the timeout */
    FS_PILOT_LOST,       /* the gateway reported the pilot's connection closed */
    FS_GATEWAY_LOST,     /* the gateway's connection to the core closed */
    FS_SESSION_CHANGED,  /* a different pilot session started while armed */
    FS_MANUAL,           /* the pilot pressed FAILSAFE */
    FS_RF_LOST,          /* aquila20: no radio link report with LQ > 0 for rf_timeout */
} fs_reason_t;

typedef enum { FC_UNKNOWN = 0, FC_DISARMED = 1, FC_ARMED = 2 } fc_arm_t;

typedef enum {
    REFUSE_NONE = 0,
    REFUSE_WRONG_SESSION,
    REFUSE_NOT_DISARMED,
    REFUSE_NOT_IN_FAILSAFE,
    REFUSE_LINK_STALE,
    REFUSE_THROTTLE_HIGH,
    REFUSE_FC_STILL_ARMED,
} refuse_t;

typedef struct {
    int16_t roll, pitch, yaw;  /* -1000..1000 */
    uint16_t throttle;         /* 0..1000 */
    uint8_t mode;              /* 0..2 */
} stick_cmd_t;

typedef struct {
    int64_t timeout_ns;
    int64_t fc_fresh_ns;
    uint16_t throttle_arm_max;

    safety_state_t state;
    fs_reason_t fs_reason;
    uint32_t session;          /* current pilot session; 0 = none */
    uint32_t last_seq;
    bool have_cmd;
    int64_t last_cmd_ns;
    stick_cmd_t cmd;           /* last command the pilot sent (clamped) */
    fc_arm_t fc_arm;
    int64_t fc_arm_ns;
    int64_t rf_timeout_ns;     /* 0 = off (betaflight: the FC has its own RX-loss failsafe) */
    int64_t rf_ok_ns;          /* last link report with uplink LQ > 0 */
    rc_outputs_t out;          /* what goes on the air */
} safety_t;

void safety_init(safety_t *s, int64_t timeout_ns, int64_t fc_fresh_ns, uint16_t throttle_arm_max);
bool safety_link_fresh(const safety_t *s, int64_t now);

/* A pilot took control. If armed, that is a failsafe (FS_SESSION_CHANGED). */
void safety_session_start(safety_t *s, uint32_t session);
/* Returns true if the command was fresh and applied. */
bool safety_control(safety_t *s, uint32_t session, uint32_t seq, const stick_cmd_t *cmd, int64_t now);
refuse_t safety_arm(safety_t *s, uint32_t session, int64_t now);
/* Always allowed. In FAILSAFE it drops ARM but keeps the failsafe latched. */
void safety_disarm(safety_t *s);
refuse_t safety_ack(safety_t *s, uint32_t session, int64_t now);
void safety_pilot_lost(safety_t *s, uint32_t session);
void safety_gateway_lost(safety_t *s);
/* Enter FAILSAFE from any state (keeps the first reason if already in FAILSAFE). */
void safety_trigger(safety_t *s, fs_reason_t reason);
/* Betaflight appends '*' to its flight-mode string while disarmed. */
void safety_fc_flight_mode(safety_t *s, const char *mode, int64_t now);
/* Aquila20 profile: the drone disarms itself when its radio link drops and never reports it,
 * so the core follows: armed + no link report with uplink LQ > 0 for `timeout_ns` ->
 * FAILSAFE rf_lost. Off (0) unless set. */
void safety_set_rf_timeout(safety_t *s, int64_t timeout_ns);
/* Called for every link-statistics report; linked = uplink LQ > 0. */
void safety_rf_link(safety_t *s, bool linked, int64_t now);
void safety_tick(safety_t *s, int64_t now);

const char *safety_state_name(safety_state_t st);
const char *safety_reason_name(fs_reason_t r);
const char *safety_refuse_name(refuse_t r);

#endif
