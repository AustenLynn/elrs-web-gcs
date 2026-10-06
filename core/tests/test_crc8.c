#include "check.h"
#include "crc8.h"

static void test_d5_check_value(void)
{
    /* Published check value of CRC-8/DVB-S2 for "123456789". */
    CHECK_EQ_INT(crc8_d5((const uint8_t *)"123456789", 9), 0xBC);
}

static void test_ba_check_value(void)
{
    /* MSB-first, poly 0xBA, init 0 (EdgeTX crc8_BA). Computed by an independent implementation. */
    CHECK_EQ_INT(crc8_ba((const uint8_t *)"123456789", 9), 0x20);
}

static void test_empty_input_is_zero(void)
{
    CHECK_EQ_INT(crc8_d5(NULL, 0), 0);
    CHECK_EQ_INT(crc8_ba(NULL, 0), 0);
}

int main(void)
{
    RUN(test_d5_check_value);
    RUN(test_ba_check_value);
    RUN(test_empty_input_is_zero);
    return CHECK_EXIT();
}
