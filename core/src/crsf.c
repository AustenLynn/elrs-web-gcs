#include "crsf.h"
#include "crc8.h"

uint16_t crsf_us_to_ch(int us)
{
    /* ch = 992 + (us - 1500) * 1.6, rounded half away from zero */
    long num = (long)(us - 1500) * 16;
    long q = num >= 0 ? (num + 5) / 10 : -((-num + 5) / 10);
    long ch = CRSF_CH_MID + q;
    if (ch < CRSF_CH_MIN)
        ch = CRSF_CH_MIN;
    if (ch > CRSF_CH_MAX)
        ch = CRSF_CH_MAX;
    return (uint16_t)ch;
}

int crsf_ch_to_us(uint16_t ch)
{
    /* us = 1500 + (ch - 992) * 0.625, rounded half away from zero */
    long num = ((long)ch - CRSF_CH_MID) * 5;
    long q = num >= 0 ? (num + 4) / 8 : -((-num + 4) / 8);
    return (int)(1500 + q);
}

void crsf_build_rc_frame(uint8_t out[CRSF_RC_FRAME_LEN], const uint16_t ch[CRSF_NUM_CHANNELS])
{
    out[0] = CRSF_ADDR_MODULE;
    out[1] = 24;                    /* type + 22 payload bytes + CRC */
    out[2] = CRSF_TYPE_RC_CHANNELS;

    uint32_t bits = 0;
    int nbits = 0;
    size_t o = 3;
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++) {
        bits |= (uint32_t)(ch[i] & 0x7FF) << nbits;
        nbits += 11;
        while (nbits >= 8) {
            out[o++] = (uint8_t)(bits & 0xFF);
            bits >>= 8;
            nbits -= 8;
        }
    }
    out[25] = crc8_d5(out + 2, 23);
}

void crsf_unpack_channels(const uint8_t payload[22], uint16_t ch[CRSF_NUM_CHANNELS])
{
    uint32_t bits = 0;
    int nbits = 0;
    size_t in = 0;
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++) {
        while (nbits < 11) {
            bits |= (uint32_t)payload[in++] << nbits;
            nbits += 8;
        }
        ch[i] = (uint16_t)(bits & 0x7FF);
        bits >>= 11;
        nbits -= 11;
    }
}

size_t crsf_build_ping(uint8_t *out, size_t cap)
{
    if (cap < 6)
        return 0;
    out[0] = CRSF_ADDR_MODULE;
    out[1] = 4;                     /* type + destination + origin + CRC */
    out[2] = CRSF_TYPE_PING;
    out[3] = 0x00;                  /* destination: broadcast */
    out[4] = CRSF_ADDR_HANDSET;     /* origin: answers come back to us */
    out[5] = crc8_d5(out + 2, 3);
    return 6;
}

size_t crsf_build_model_select(uint8_t *out, size_t cap, uint8_t model_id)
{
    if (cap < 10)
        return 0;
    out[0] = CRSF_ADDR_SYNC;
    out[1] = 8;
    out[2] = CRSF_TYPE_COMMAND;
    out[3] = CRSF_ADDR_MODULE;      /* destination */
    out[4] = CRSF_ADDR_HANDSET;     /* origin */
    out[5] = 0x10;                  /* sub-command group: CRSF */
    out[6] = 0x05;                  /* command: model select */
    out[7] = model_id;
    out[8] = crc8_ba(out + 2, 6);   /* inner command CRC */
    out[9] = crc8_d5(out + 2, 7);   /* frame CRC covers the inner CRC too */
    return 10;
}
