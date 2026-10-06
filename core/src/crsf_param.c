#include "crsf_param.h"

#include <string.h>
#include <strings.h>

#include "crc8.h"
#include "crsf.h"

static size_t build4(uint8_t *out, size_t cap, uint8_t type, uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
    if (cap < 8)
        return 0;
    out[0] = CRSF_ADDR_MODULE;
    out[1] = 6;
    out[2] = type;
    out[3] = a;
    out[4] = b;
    out[5] = c;
    out[6] = d;
    out[7] = crc8_d5(out + 2, 5);
    return 8;
}

size_t crsf_build_param_read(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t chunk)
{
    return build4(out, cap, CRSF_TYPE_PARAM_READ, device, CRSF_ADDR_LUA, field, chunk);
}

size_t crsf_build_param_write(uint8_t *out, size_t cap, uint8_t device, uint8_t field, uint8_t value)
{
    return build4(out, cap, CRSF_TYPE_PARAM_WRITE, device, CRSF_ADDR_LUA, field, value);
}

void param_reader_start(param_reader_t *r, uint8_t field_id)
{
    memset(r, 0, sizeof *r);
    r->field_id = field_id;
}

int param_reader_feed(param_reader_t *r, const uint8_t *f, size_t len)
{
    /* addr, len, type, dest, origin, field id, chunks remaining, data..., crc */
    if (len < 8 || f[2] != CRSF_TYPE_PARAM_ENTRY || f[5] != r->field_id)
        return -1;
    const uint8_t *data = f + 7;
    size_t n = len - 8;
    if (r->next_chunk > 0 && f[6] != r->remaining - 1)
        return -1;
    if (r->next_chunk == 0) {
        if (n < 2)
            return -1;
        r->parent = data[0];
        r->type = data[1];
        data += 2;
        n -= 2;
    }
    if (r->len + n > sizeof r->data)
        return -1;
    memcpy(r->data + r->len, data, n);
    r->len += n;
    r->remaining = f[6];
    if (f[6] == 0)
        return 1;
    r->next_chunk++;
    return 0;
}

/* Copies a NUL-terminated string starting at *pos; advances *pos past the NUL. */
static int take_str(const param_reader_t *r, size_t *pos, char *out, size_t cap)
{
    const uint8_t *start = r->data + *pos;
    const uint8_t *nul = memchr(start, '\0', r->len - *pos);
    if (nul == NULL)
        return -1;
    size_t n = (size_t)(nul - start);
    size_t copy = n < cap - 1 ? n : cap - 1;
    memcpy(out, start, copy);
    out[copy] = '\0';
    *pos += n + 1;
    return 0;
}

int param_parse(const param_reader_t *r, crsf_param_t *p)
{
    memset(p, 0, sizeof *p);
    p->id = r->field_id;
    p->parent = r->parent;
    p->type = r->type & 0x7F;
    p->hidden = (r->type & 0x80) != 0;
    size_t pos = 0;
    if (take_str(r, &pos, p->name, sizeof p->name) != 0)
        return -1;

    switch (p->type) {
    case PARAM_TEXT_SELECTION:
        /* options\0 value min max default unit\0 */
        if (take_str(r, &pos, p->options, sizeof p->options) != 0 || pos + 4 > r->len)
            return -1;
        p->value = r->data[pos];
        pos += 4;
        if (take_str(r, &pos, p->text, sizeof p->text) != 0)
            p->text[0] = '\0';
        return 0;
    case PARAM_INFO:
    case PARAM_STRING:
        return take_str(r, &pos, p->text, sizeof p->text);
    case PARAM_UINT8:
    case PARAM_INT8:
        if (pos >= r->len)
            return -1;
        p->value = r->data[pos];
        return 0;
    default:
        return 0;   /* folders and commands: the name is all we show */
    }
}

const char *param_option(const crsf_param_t *p, int index, char *buf, size_t cap)
{
    const char *s = p->options;
    buf[0] = '\0';
    if (index < 0)
        return buf;
    for (int i = 0; i < index; i++) {
        s = strchr(s, ';');
        if (s == NULL)
            return buf;
        s++;
    }
    size_t n = strcspn(s, ";");
    if (n >= cap)
        n = cap - 1;
    memcpy(buf, s, n);
    buf[n] = '\0';
    return buf;
}

int param_option_index(const crsf_param_t *p, const char *prefix)
{
    size_t plen = strlen(prefix);
    const char *s = p->options;
    for (int i = 0;; i++) {
        size_t n = strcspn(s, ";");
        if (n > 0 && n >= plen && strncasecmp(s, prefix, plen) == 0)
            return i;
        if (s[n] == '\0')
            return -1;
        s += n + 1;
    }
}
