/* crc8.h - the two CRC-8 variants used by CRSF. */
#ifndef CRC8_H
#define CRC8_H

#include <stddef.h>
#include <stdint.h>

/* Frame CRC: polynomial 0xD5 (CRC-8/DVB-S2), over type byte .. last payload byte. */
uint8_t crc8_d5(const uint8_t *data, size_t len);

/* Inner CRC of CRSF command frames (type 0x32): polynomial 0xBA, as EdgeTX computes it. */
uint8_t crc8_ba(const uint8_t *data, size_t len);

#endif
