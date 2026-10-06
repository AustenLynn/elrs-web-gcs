/* crsf_telem.h - decode the CRSF frames an ELRS TX module sends to the handset. */
#ifndef CRSF_TELEM_H
#define CRSF_TELEM_H

#include <stddef.h>
#include <stdint.h>
#include "crsf.h"

typedef struct {
    int8_t up_rssi1;        /* dBm, measured by the receiver (antenna 1) */
    int8_t up_rssi2;        /* dBm, antenna 2 */
    uint8_t up_lq;          /* uplink link quality, % */
    int8_t up_snr;          /* dB */
    uint8_t antenna;
    uint8_t rf_mode;        /* ELRS packet-rate index */
    uint16_t tx_power_mw;
    int8_t dn_rssi;         /* dBm, measured by the TX module */
    uint8_t dn_lq;          /* downlink link quality, % */
    int8_t dn_snr;          /* dB */
} crsf_link_stats_t;

typedef struct {
    uint16_t voltage_dv;    /* 0.1 V */
    uint16_t current_da;    /* 0.1 A */
    uint32_t capacity_mah;  /* used */
    uint8_t remaining_pct;
} crsf_battery_t;

typedef struct {
    char mode[16];          /* Betaflight: e.g. "ACRO", "!FS!"; '*' suffix means disarmed */
} crsf_flight_mode_t;

typedef struct {
    uint32_t interval_0p1us; /* frame interval the module wants, in 0.1 us */
    int32_t offset_0p1us;    /* phase correction: positive = send the next frame later */
} crsf_timing_t;

typedef struct {
    uint8_t origin;
    char name[32];
    uint32_t serial;        /* 0x454C5253 ("ELRS") for ExpressLRS devices */
    uint8_t sw_major, sw_minor, sw_patch;
    uint8_t field_count;
    uint8_t param_version;
} crsf_device_info_t;

typedef enum {
    CRSF_MSG_NONE = 0,
    CRSF_MSG_LINK_STATS,
    CRSF_MSG_BATTERY,
    CRSF_MSG_FLIGHT_MODE,
    CRSF_MSG_TIMING,
    CRSF_MSG_DEVICE_INFO,
    CRSF_MSG_RC_CHANNELS,
} crsf_msg_kind_t;

typedef struct {
    crsf_msg_kind_t kind;
    union {
        crsf_link_stats_t link;
        crsf_battery_t battery;
        crsf_flight_mode_t flight_mode;
        crsf_timing_t timing;
        crsf_device_info_t device;
        uint16_t channels[CRSF_NUM_CHANNELS];
    } u;
} crsf_msg_t;

/* Decode one complete frame (as delivered by the deframer, CRC already checked).
 * Returns the message kind; CRSF_MSG_NONE for unknown types or malformed lengths. */
crsf_msg_kind_t crsf_decode(const uint8_t *frame, size_t len, crsf_msg_t *out);

#endif
