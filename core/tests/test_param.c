#include "check.h"
#include "crc8.h"
#include "crsf_param.h"

/* Builds a PARAMETER_ENTRY frame the way an ELRS module sends it. */
static size_t entry(uint8_t *out, uint8_t field, uint8_t remaining, const uint8_t *data, size_t n)
{
    out[0] = 0xEA;
    out[1] = (uint8_t)(n + 6);   /* type, dest, origin, field, remaining, data..., crc */
    out[2] = CRSF_TYPE_PARAM_ENTRY;
    out[3] = CRSF_ADDR_LUA;
    out[4] = 0xEE;
    out[5] = field;
    out[6] = remaining;
    memcpy(out + 7, data, n);
    out[7 + n] = crc8_d5(out + 2, n + 5);
    return n + 8;
}

/* One field in one chunk. */
static int read_one(param_reader_t *r, uint8_t field, const uint8_t *data, size_t n)
{
    uint8_t f[128];
    param_reader_start(r, field);
    return param_reader_feed(r, f, entry(f, field, 0, data, n));
}

/* parent 0, type 9, "Packet Rate", options with a hidden (empty) one, value 2,
 * min 0, max 3, default 2, unit "" */
static const uint8_t PACKET_RATE[] = "\x00\x09Packet Rate\0" "50Hz;;250Hz;500Hz\0" "\x02\x00\x03\x02" "";

static void test_read_and_write_frames(void)
{
    static const uint8_t read_golden[] = { 0xEE, 0x06, 0x2C, 0xEE, 0xEF, 0x01, 0x00, 0x76 };
    static const uint8_t write_golden[] = { 0xEE, 0x06, 0x2D, 0xEE, 0xEF, 0x05, 0x03, 0x46 };
    uint8_t buf[16];
    CHECK_EQ_INT(crsf_build_param_read(buf, sizeof buf, 0xEE, 1, 0), sizeof read_golden);
    CHECK_MEM(buf, read_golden, sizeof read_golden);
    CHECK_EQ_INT(crsf_build_param_write(buf, sizeof buf, 0xEE, 5, 3), sizeof write_golden);
    CHECK_MEM(buf, write_golden, sizeof write_golden);
    CHECK_EQ_INT(crsf_build_param_read(buf, 7, 0xEE, 1, 0), 0);
}

static void test_text_selection_in_two_chunks(void)
{
    uint8_t f1[64], f2[64];
    size_t first = 14;
    size_t n1 = entry(f1, 4, 1, PACKET_RATE, first);
    size_t n2 = entry(f2, 4, 0, PACKET_RATE + first, sizeof PACKET_RATE - first);

    param_reader_t r;
    param_reader_start(&r, 4);
    CHECK_EQ_INT(param_reader_feed(&r, f1, n1), 0);
    CHECK_EQ_INT(r.next_chunk, 1);
    CHECK_EQ_INT(param_reader_feed(&r, f2, n2), 1);

    crsf_param_t p;
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_EQ_INT(p.id, 4);
    CHECK_EQ_INT(p.type, PARAM_TEXT_SELECTION);
    CHECK(!p.hidden);
    CHECK_STR(p.name, "Packet Rate");
    CHECK_STR(p.options, "50Hz;;250Hz;500Hz");
    CHECK_EQ_INT(p.value, 2);
    CHECK_STR(p.text, "");
}

static void test_repeated_chunk_is_rejected(void)
{
    /* ELRS answers a retried request again: chunk 0 twice must not corrupt the field. */
    uint8_t f1[64], f2[64];
    size_t first = 14;
    size_t n1 = entry(f1, 4, 1, PACKET_RATE, first);
    size_t n2 = entry(f2, 4, 0, PACKET_RATE + first, sizeof PACKET_RATE - first);
    param_reader_t r;
    param_reader_start(&r, 4);
    CHECK_EQ_INT(param_reader_feed(&r, f1, n1), 0);
    CHECK_EQ_INT(param_reader_feed(&r, f1, n1), -1);     /* duplicate of chunk 0 */
    CHECK_EQ_INT(param_reader_feed(&r, f2, n2), 1);
    crsf_param_t p;
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_STR(p.options, "50Hz;;250Hz;500Hz");
}

static void test_option_lookup(void)
{
    param_reader_t r;
    crsf_param_t p;
    CHECK_EQ_INT(read_one(&r, 4, PACKET_RATE, sizeof PACKET_RATE), 1);
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    char buf[32];
    CHECK_STR(param_option(&p, 2, buf, sizeof buf), "250Hz");
    CHECK_STR(param_option(&p, 1, buf, sizeof buf), "");        /* hidden option */
    CHECK_STR(param_option(&p, 9, buf, sizeof buf), "");
    CHECK_EQ_INT(param_option_index(&p, "250"), 2);
    CHECK_EQ_INT(param_option_index(&p, "500hz"), 3);
    CHECK_EQ_INT(param_option_index(&p, "1000"), -1);
    CHECK_EQ_INT(param_option_index(&p, ""), 0);
}

static void test_info_and_hidden_folder(void)
{
    static const uint8_t info[] = "\x00\x0C" "Bad/Good\0" "0/250";
    static const uint8_t folder[] = "\x00\x8B" "TX Power\0" "\x04\x05\xFF";
    param_reader_t r;
    crsf_param_t p;
    CHECK_EQ_INT(read_one(&r, 6, info, sizeof info), 1);
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_EQ_INT(p.type, PARAM_INFO);
    CHECK_STR(p.text, "0/250");

    CHECK_EQ_INT(read_one(&r, 3, folder, sizeof folder - 1), 1);
    CHECK_EQ_INT(param_parse(&r, &p), 0);
    CHECK_EQ_INT(p.type, PARAM_FOLDER);
    CHECK(p.hidden);
    CHECK_STR(p.name, "TX Power");
}

static void test_wrong_frames_are_rejected(void)
{
    uint8_t f[64];
    param_reader_t r;
    param_reader_start(&r, 4);
    CHECK_EQ_INT(param_reader_feed(&r, f, entry(f, 5, 0, PACKET_RATE, 10)), -1);  /* other field */
    static const uint8_t ping[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
    CHECK_EQ_INT(param_reader_feed(&r, ping, sizeof ping), -1);
}

static void test_malformed_data(void)
{
    static const uint8_t no_nul[] = { 0x00, 0x09, 'A', 'B' };
    static const uint8_t short_sel[] = "\x00\x09Rate\0" "a;b";          /* options never end */
    param_reader_t r;
    crsf_param_t p;
    CHECK_EQ_INT(read_one(&r, 1, no_nul, sizeof no_nul), 1);
    CHECK_EQ_INT(param_parse(&r, &p), -1);
    CHECK_EQ_INT(read_one(&r, 1, short_sel, sizeof short_sel - 1), 1);
    CHECK_EQ_INT(param_parse(&r, &p), -1);
}

int main(void)
{
    RUN(test_read_and_write_frames);
    RUN(test_text_selection_in_two_chunks);
    RUN(test_repeated_chunk_is_rejected);
    RUN(test_option_lookup);
    RUN(test_info_and_hidden_folder);
    RUN(test_wrong_frames_are_rejected);
    RUN(test_malformed_data);
    return CHECK_EXIT();
}
