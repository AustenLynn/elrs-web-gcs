/* ipc_proto.h - messages between crsf-core and the gateway over a Unix stream socket.
 *
 * Every message: u16 length (little-endian, counts type + payload) | u8 type | payload.
 * All integers little-endian. The JavaScript twin is gateway/src/ipc.js. */
#ifndef IPC_PROTO_H
#define IPC_PROTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "crsf_telem.h"
#include "safety.h"

#define IPC_MAX_MSG 255   /* type + payload */

/* gateway -> core */
#define IPC_SESSION     0x01  /* u32 session: a pilot took control */
#define IPC_CONTROL     0x02  /* u32 session, u32 seq, i16 roll, i16 pitch, i16 yaw, u16 throttle, u8 mode */
#define IPC_ARM         0x03  /* u32 session */
#define IPC_DISARM      0x04  /* u32 session */
#define IPC_ACK         0x05  /* u32 session: clear a latched failsafe */
#define IPC_PILOT_LOST  0x06  /* u32 session */
#define IPC_FAILSAFE    0x07  /* u32 session: pilot pressed FAILSAFE */

/* core -> gateway */
#define IPC_STATUS      0x81  /* ipc_status_t, 10 times per second */
#define IPC_LINK        0x82  /* link statistics */
#define IPC_BATTERY     0x83
#define IPC_FLIGHT_MODE 0x84  /* u8 n, n chars */
#define IPC_DEVICE      0x85  /* u8 origin, u8 major, u8 minor, u8 patch, u32 serial, u8 n, n chars */
#define IPC_EVENT       0x86  /* u8 kind, u8 detail, u32 session */

#define IPC_EVENT_ARM_REFUSED 1   /* detail = refuse_t */
#define IPC_EVENT_ACK_REFUSED 2   /* detail = refuse_t */

#define IPC_STATUS_LEN 80         /* payload bytes */
#define IPC_NO_CMD_AGE 0xFFFFFFFFu

typedef struct {
    uint32_t session;
    uint32_t seq;
    stick_cmd_t sticks;
} ipc_control_t;

typedef struct {
    uint8_t state;            /* safety_state_t */
    uint8_t fs_reason;        /* fs_reason_t */
    uint8_t fc_arm;           /* fc_arm_t */
    uint8_t serial_ok;
    uint32_t session;
    uint32_t last_seq;
    uint32_t cmd_age_ms;      /* IPC_NO_CMD_AGE if no command yet */
    uint32_t frames_sent;
    uint32_t tx_errors;
    uint32_t rx_frames;
    uint32_t rx_crc_errors;
    uint32_t period_us;
    int32_t offset_0p1us;     /* last offset reported by the module */
    uint32_t timing_frames;
    uint32_t wake_late_max_us;/* worst frame-loop wake-up delay since the last status */
    uint16_t channels[CRSF_NUM_CHANNELS];
} ipc_status_t;

typedef void (*ipc_msg_cb)(uint8_t type, const uint8_t *payload, size_t plen, void *user);

typedef struct {
    uint8_t buf[2 + IPC_MAX_MSG];
    size_t len;
} ipc_reader_t;

void ipc_reader_init(ipc_reader_t *r);
/* Calls cb for each complete message. Returns -1 on a corrupt stream (bad length). */
int ipc_reader_feed(ipc_reader_t *r, const uint8_t *data, size_t n, ipc_msg_cb cb, void *user);

/* Encoders return the total number of bytes written (header included), 0 if cap is too small. */
size_t ipc_encode_session_msg(uint8_t *out, size_t cap, uint8_t type, uint32_t session);
size_t ipc_encode_control(uint8_t *out, size_t cap, const ipc_control_t *c);
size_t ipc_encode_status(uint8_t *out, size_t cap, const ipc_status_t *s);
size_t ipc_encode_link(uint8_t *out, size_t cap, const crsf_link_stats_t *l);
size_t ipc_encode_battery(uint8_t *out, size_t cap, const crsf_battery_t *b);
size_t ipc_encode_flight_mode(uint8_t *out, size_t cap, const char *mode);
size_t ipc_encode_device(uint8_t *out, size_t cap, const crsf_device_info_t *d);
size_t ipc_encode_event(uint8_t *out, size_t cap, uint8_t kind, uint8_t detail, uint32_t session);

/* Decoders take the payload (after the type byte). Return 0, or -1 if the length is wrong. */
int ipc_decode_session_msg(const uint8_t *p, size_t n, uint32_t *session);
int ipc_decode_control(const uint8_t *p, size_t n, ipc_control_t *c);
int ipc_decode_status(const uint8_t *p, size_t n, ipc_status_t *s);

#endif
