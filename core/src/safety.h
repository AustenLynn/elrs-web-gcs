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
 *    always ends DISARMED; flying again needs a new, explicit arm request.
 *  - With the hold enabled (hold_ns > 0), cmd_timeout and pilot_lost for the active session
 *    enter HOLD instead of failing safe: ARM high, sticks centred, throttle = hold_throttle,
 *    flight mode Normal, turtle off. If the last throttle was at or below throttle_arm_max
 *    (maybe on the ground), it skips HOLD and enters LANDING. HOLD ends after hold_ns in
 *    LANDING (throttle minimum, otherwise as HOLD); LANDING ends after land_ns in FAILSAFE
 *    with the reason that started the hold.
 *  - In HOLD, a fresh command from the session that timed out resumes (ARMED). The standby
 *    session may TAKE (HOLD or LANDING: it becomes the active session, and its first fresh
 *    command makes it ARMED; the countdown runs on until then) or LAND (HOLD only).
 *    After pilot_lost the seat is lost: no resume, and the session is cleared when the
 *    stage ends.
 *  - Desarmar, manual FAILSAFE, gateway_lost, rf_lost and a new session act at once from
 *    HOLD and LANDING as from ARMED. */
#ifndef SAFETY_H
#define SAFETY_H

#include <stdbool.h>
#include <stdint.h>
#include "chmap.h"

typedef enum {
    SAFETY_DISARMED = 0,
    SAFETY_ARMED = 1,
    SAFETY_FAILSAFE = 2,
    SAFETY_HOLD = 3,           /* lost the pilot: hovering at hold_throttle for hold_ns */
    SAFETY_LANDING = 4,        /* throttle minimum for land_ns, then FAILSAFE */
} safety_state_t;

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
    REFUSE_RF_DOWN,            /* arm: no radio link with the drone (only with an rf timeout) */
    REFUSE_NOT_STANDBY,        /* take/land: not the standby session */
    REFUSE_NOT_IN_HOLD,        /* take: not in HOLD or LANDING; land: not in HOLD */
} refuse_t;

/* What the hold reports to the gateway (safety_take_report). */
typedef enum { HOLD_EV_HOLD = 1, HOLD_EV_RESUMED, HOLD_EV_TAKEN, HOLD_EV_LANDING } hold_ev_t;

#define SAFETY_REPORT_CAP 4

typedef struct {
    hold_ev_t ev;
    fs_reason_t reason;        /* what started the hold */
    uint32_t session;          /* the active session after the change */
} hold_report_t;

typedef struct {
    int16_t roll, pitch, yaw;  /* -1000..1000 */
    uint16_t throttle;         /* 0..1000 */
    uint8_t mode;              /* 0..2 */
    uint8_t speed;             /* 0..2 (aquila20 CH7: Slow, Mid, Fast) */
    bool turtle;               /* aquila20 CH8 */
} stick_cmd_t;

typedef struct {
    int64_t timeout_ns;
    int64_t fc_fresh_ns;
    uint16_t throttle_arm_max;

    safety_state_t state;
    fs_reason_t fs_reason;
    uint32_t session;          /* current pilot session; 0 = none */
    uint32_t standby;          /* queue head, may TAKE or LAND during the hold; 0 = none */
    int64_t hold_ns;           /* 0 = off: cmd_timeout and pilot_lost fail safe at once */
    int64_t land_ns;
    uint16_t hold_throttle;
    int64_t stage_end_ns;      /* when HOLD or LANDING ends */
    fs_reason_t hold_reason;   /* what started the hold; the FAILSAFE reason when it ends */
    uint32_t resume_session;   /* session whose next fresh command resumes; 0 = no resume */
    bool seat_lost;            /* pilot_lost during the hold: clear the session when it ends */
    bool take_pending;         /* taken, no fresh command from the new session yet */
    hold_report_t reports[SAFETY_REPORT_CAP];
    uint8_t report_head, report_count;
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
/* Always allowed for the current session; other sessions are ignored. In FAILSAFE it drops
 * ARM but keeps the failsafe latched. */
void safety_disarm(safety_t *s, uint32_t session);
/* The pilot pressed FAILSAFE. Ignored unless it comes from the current session. */
void safety_manual_failsafe(safety_t *s, uint32_t session);
refuse_t safety_ack(safety_t *s, uint32_t session, int64_t now);
/* Enters HOLD if armed and the hold is enabled; during HOLD or LANDING marks the seat lost. */
void safety_pilot_lost(safety_t *s, uint32_t session, int64_t now);
void safety_gateway_lost(safety_t *s);
/* Registers the standby session; 0 clears it. A non-zero session equal to the current one is
 * ignored. */
void safety_set_standby(safety_t *s, uint32_t session);
/* hold_ns 0 turns the hold off. */
void safety_set_hold(safety_t *s, int64_t hold_ns, int64_t land_ns, uint16_t hold_throttle);
/* The standby takes control during HOLD or LANDING. The state stays until its first fresh
 * command. */
refuse_t safety_take(safety_t *s, uint32_t session, int64_t now);
/* The standby chooses to land during HOLD. */
refuse_t safety_land(safety_t *s, uint32_t session, int64_t now);
/* Pops the oldest pending report (FIFO of SAFETY_REPORT_CAP; on overflow the newest is
 * dropped). */
bool safety_take_report(safety_t *s, hold_ev_t *ev, fs_reason_t *reason, uint32_t *session);
/* Time left in HOLD or LANDING, rounded up; 0 in any other state. */
uint32_t safety_stage_left_ms(const safety_t *s, int64_t now);
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
const char *safety_hold_ev_name(hold_ev_t e);

#endif
