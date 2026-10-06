#include "crc8.h"

static uint8_t crc8_poly(const uint8_t *data, size_t len, uint8_t poly)
{
    uint8_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++)
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ poly) : (uint8_t)(crc << 1);
    }
    return crc;
}

uint8_t crc8_d5(const uint8_t *data, size_t len)
{
    return crc8_poly(data, len, 0xD5);
}

uint8_t crc8_ba(const uint8_t *data, size_t len)
{
    return crc8_poly(data, len, 0xBA);
}
