/* crsf_param.h - the ELRS "Lua" parameter protocol: read a device's settings (packet
 * rate, telemetry ratio, TX power, ...) and change text-selection settings.
 *
 * Read:  PARAMETER_READ  (0x2C) dest, origin, field id, chunk
 * Reply: PARAMETER_ENTRY (0x2B) dest, origin, field id, chunks remaining, data...
 *        Chunk 0 data starts with parent id and type; the chunks concatenated form
 *        "name\0" followed by type-specific fields.
 * Write: PARAMETER_WRITE (0x2D) dest, origin, field id, value */
#ifndef CRSF_PARAM_H
#define CRSF_PARAM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CRSF_TYPE_PARAM_ENTRY 0x2B
#define CRSF_TYPE_PARAM_READ  0x2C
#define CRSF_TYPE_PARAM_WRITE 0x2D
#define CRSF_ADDR_LUA         0xEF  /* origin used by the ELRS Lua script */

typedef enum {
    PARAM_UINT8 = 0,
    PARAM_INT8 = 1,
    PARAM_TEXT_SELECTION = 9,
    PARAM_STRING = 10,
    PARAM_FOLDER = 11,
    PARAM_INFO = 12,
    PARAM_COMMAND = 13,
} param_type_t;

typedef struct {
    uint8_t id;
    uint8_t parent;
    uint8_t type;          /* param_type_t (hidden bit removed) */
    bool hidden;
    char name[48];
    char options[512];     /* text selection: ';'-separated, may contain empty (hidden) options */
    uint8_t value;         /* text selection index / uint8 value */
    char text[64];         /* info and string value, or text-selection unit */
} crsf_param_t;

typedef struct {
    uint8_t field_id;
    uint8_t parent;
    uint8_t type;
    uint8_t data[1024];
    size_t len;
    int next_chunk;        /* chunk index to request next */
    int remaining;         /* "chunks remaining" of the last accepted chunk */
} param_reader_t;

size_t crsf_build_param_read(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t chunk);
size_t crsf_build_param_write(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t value);

void param_reader_start(param_reader_t *r, uint8_t field_id);
/* Feed one complete frame. Returns 1 when the field is complete, 0 if the next chunk
 * (r->next_chunk) must be requested, -1 if the frame is not the expected chunk (other
 * field, or a repeated/skipped chunk, which ELRS sends when a request is retried). */
int param_reader_feed(param_reader_t *r, const uint8_t *frame, size_t len);
/* Decode a completed reader. Returns 0, or -1 if the data is malformed. */
int param_parse(const param_reader_t *r, crsf_param_t *out);

/* Index of the first non-empty option starting with `prefix` (case-insensitive), or -1. */
int param_option_index(const crsf_param_t *p, const char *prefix);
/* Copies option `index` into buf ("" if out of range). Returns buf. */
const char *param_option(const crsf_param_t *p, int index, char *buf, size_t cap);

#endif
