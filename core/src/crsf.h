/* crsf.h - CRSF protocol constants, channel conversion and the frames we send. */
#ifndef CRSF_H
#define CRSF_H

#include <stddef.h>
#include <stdint.h>

#define CRSF_ADDR_SYNC      0xC8  /* flight-controller address, also used as a generic sync byte */
#define CRSF_ADDR_HANDSET   0xEA  /* the "radio" side of the link: this program */
#define CRSF_ADDR_MODULE    0xEE  /* the ELRS TX module */

#define CRSF_TYPE_BATTERY      0x08
#define CRSF_TYPE_LINK_STATS   0x14
#define CRSF_TYPE_RC_CHANNELS  0x16
#define CRSF_TYPE_FLIGHT_MODE  0x21
#define CRSF_TYPE_PING         0x28
#define CRSF_TYPE_DEVICE_INFO  0x29
#define CRSF_TYPE_COMMAND      0x32
#define CRSF_TYPE_RADIO_ID     0x3A
#define CRSF_RADIO_ID_TIMING   0x10  /* "OpenTX sync" timing frame inside RADIO_ID */

#define CRSF_FRAME_MAX       64     /* whole frame: address + length + type + payload + CRC */
#define CRSF_NUM_CHANNELS    16
#define CRSF_RC_FRAME_LEN    26
#define CRSF_CH_MIN          172    /* ~988 us */
#define CRSF_CH_MID          992    /* 1500 us */
#define CRSF_CH_MAX          1811   /* ~2012 us */

/* Pulse width in microseconds -> CRSF channel value (rounded, clamped to MIN..MAX). */
uint16_t crsf_us_to_ch(int us);
/* CRSF channel value -> pulse width in microseconds (rounded). */
int crsf_ch_to_us(uint16_t ch);

/* RC_CHANNELS_PACKED frame addressed to the TX module: 16 x 11-bit values, LSB first. */
void crsf_build_rc_frame(uint8_t out[CRSF_RC_FRAME_LEN], const uint16_t ch[CRSF_NUM_CHANNELS]);
/* Inverse of the packing above; payload points at the 22 bytes after the type byte. */
void crsf_unpack_channels(const uint8_t payload[22], uint16_t ch[CRSF_NUM_CHANNELS]);

/* Device ping (broadcast). Every CRSF device answers with DEVICE_INFO. Returns length or 0. */
size_t crsf_build_ping(uint8_t *out, size_t cap);
/* "Model select" command: ELRS loads that model slot's settings. Returns length or 0. */
size_t crsf_build_model_select(uint8_t *out, size_t cap, uint8_t model_id);

#endif
