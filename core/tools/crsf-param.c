/* crsf-param - read and change ELRS TX module settings without a radio handset.
 *
 *   crsf-param [-b baud] <device> list
 *   crsf-param [-b baud] <device> set "<setting name>" <option prefix>
 *
 * Example: crsf-param /dev/ttyUSB0 set "Packet Rate" 250Hz
 * Stop crsf-core first: only one program can use the port. While it runs, the tool
 * streams disarmed RC frames (the module only answers a live "handset").
 * Exit status: 0 ok, 1 module/setting problem, 2 usage or I/O error. */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#include "crsf.h"
#include "crsf_deframer.h"
#include "crsf_param.h"
#include "crsf_telem.h"
#include "serial.h"
#include "timeutil.h"

#define MAX_FIELDS 64

typedef struct {
    int fd;
    crsf_deframer_t d;
    uint8_t rc[CRSF_RC_FRAME_LEN];
    int64_t next_rc;
    bool have_device;
    crsf_device_info_t device;
    param_reader_t reader;
    bool reading;
    int read_state;            /* 0 waiting, 1 complete, -2 next chunk needed */
    crsf_param_t fields[MAX_FIELDS + 1];
    bool loaded[MAX_FIELDS + 1];
} tool_t;

static void on_frame(const uint8_t *frame, size_t len, void *user)
{
    tool_t *t = user;
    if (frame[2] == CRSF_TYPE_PARAM_ENTRY && t->reading) {
        int r = param_reader_feed(&t->reader, frame, len);
        if (r == 1)
            t->read_state = 1;
        else if (r == 0)
            t->read_state = -2;
        return;
    }
    crsf_msg_t m;
    if (crsf_decode(frame, len, &m) == CRSF_MSG_DEVICE_INFO && m.u.device.origin == CRSF_ADDR_MODULE) {
        t->device = m.u.device;
        t->have_device = true;
    }
}

static int send_frame(tool_t *t, const uint8_t *buf, size_t n)
{
    ssize_t w = write(t->fd, buf, n);
    return (w == (ssize_t)n || (w < 0 && errno == EAGAIN)) ? 0 : -1;
}

/* Runs the port for `ms` milliseconds: keeps RC frames flowing and handles replies. */
static int pump(tool_t *t, int ms)
{
    int64_t end = mono_ns() + ms * NS_PER_MS;
    int64_t now;
    while ((now = mono_ns()) < end) {
        if (now >= t->next_rc) {
            if (send_frame(t, t->rc, sizeof t->rc) < 0)
                return -1;
            t->next_rc = now + 4 * NS_PER_MS;
        }
        int64_t wake = t->next_rc < end ? t->next_rc : end;
        struct pollfd p = { .fd = t->fd, .events = POLLIN };
        if (poll(&p, 1, (int)((wake - now + NS_PER_MS - 1) / NS_PER_MS)) > 0) {
            if (p.revents & (POLLERR | POLLHUP | POLLNVAL))
                return -1;
            uint8_t buf[256];
            ssize_t n = read(t->fd, buf, sizeof buf);
            if (n > 0)
                crsf_deframer_feed(&t->d, buf, (size_t)n, on_frame, t);
        }
        if (t->reading && t->read_state != 0)
            return 0;          /* let the caller react to a reply right away */
    }
    return 0;
}

static int find_module(tool_t *t)
{
    uint8_t buf[16];
    if (send_frame(t, buf, crsf_build_model_select(buf, sizeof buf, 0)) < 0)
        return -1;
    for (int i = 0; i < 25 && !t->have_device; i++) {
        if (send_frame(t, buf, crsf_build_ping(buf, sizeof buf)) < 0 || pump(t, 200) < 0)
            return -1;
    }
    return t->have_device ? 0 : 1;
}

/* Reads one field (all chunks). Returns 0 ok, 1 no answer, -1 I/O error. */
static int read_field(tool_t *t, uint8_t id)
{
    uint8_t buf[16];
    param_reader_start(&t->reader, id);
    t->reading = true;
    int tries = 0;
    while (tries < 5) {
        t->read_state = 0;
        if (send_frame(t, buf, crsf_build_param_read(buf, sizeof buf, CRSF_ADDR_MODULE, id,
                                                     (uint8_t)t->reader.next_chunk)) < 0 ||
            pump(t, 100) < 0) {
            t->reading = false;
            return -1;
        }
        if (t->read_state == 1)
            break;
        tries = t->read_state == -2 ? 0 : tries + 1;   /* progress resets the retry count */
    }
    t->reading = false;
    if (t->read_state != 1 || param_parse(&t->reader, &t->fields[id]) != 0)
        return 1;
    t->loaded[id] = true;
    return 0;
}

static void format_value(const crsf_param_t *p, char *out, size_t cap)
{
    char opt[64];
    switch (p->type) {
    case PARAM_TEXT_SELECTION:
        param_option(p, p->value, opt, sizeof opt);
        snprintf(out, cap, "%.40s%s%.40s", opt, p->text[0] ? " " : "", p->text);
        break;
    case PARAM_INFO:
    case PARAM_STRING:
        snprintf(out, cap, "%.80s", p->text);
        break;
    case PARAM_UINT8:
    case PARAM_INT8:
        snprintf(out, cap, "%d", p->type == PARAM_INT8 ? (int8_t)p->value : p->value);
        break;
    case PARAM_FOLDER:
        snprintf(out, cap, "(folder)");
        break;
    default:
        snprintf(out, cap, "(command)");
        break;
    }
}

static int depth(const tool_t *t, uint8_t id)
{
    int d = 0;
    for (uint8_t p = t->fields[id].parent; p != 0 && p <= MAX_FIELDS && d < 8; p = t->fields[p].parent)
        d++;
    return d;
}

static int load_all(tool_t *t)
{
    int count = t->device.field_count < MAX_FIELDS ? t->device.field_count : MAX_FIELDS;
    for (int id = 1; id <= count; id++) {
        int r = read_field(t, (uint8_t)id);
        if (r < 0)
            return -1;
        if (r > 0)
            fprintf(stderr, "crsf-param: field %d did not answer\n", id);
    }
    return 0;
}

static int cmd_list(tool_t *t)
{
    if (load_all(t) < 0)
        return 2;
    int count = t->device.field_count < MAX_FIELDS ? t->device.field_count : MAX_FIELDS;
    for (int id = 1; id <= count; id++) {
        const crsf_param_t *p = &t->fields[id];
        if (!t->loaded[id] || p->hidden)
            continue;
        char value[96];
        format_value(p, value, sizeof value);
        printf("%*s[%2d] %s: %s\n", 2 * depth(t, (uint8_t)id), "", id, p->name, value);
        if (p->type == PARAM_TEXT_SELECTION) {
            printf("%*s     options:", 2 * depth(t, (uint8_t)id), "");
            char opt[64];
            int n_opts = 1;
            for (const char *c = p->options; *c != '\0'; c++)
                n_opts += *c == ';';
            for (int i = 0; i < n_opts; i++)
                if (param_option(p, i, opt, sizeof opt)[0] != '\0')
                    printf(" \"%s\"", opt);
            printf("\n");
        }
    }
    return 0;
}

static int cmd_set(tool_t *t, const char *name, const char *prefix)
{
    if (load_all(t) < 0)
        return 2;
    int count = t->device.field_count < MAX_FIELDS ? t->device.field_count : MAX_FIELDS;
    for (int id = 1; id <= count; id++) {
        crsf_param_t *p = &t->fields[id];
        if (!t->loaded[id] || p->type != PARAM_TEXT_SELECTION || strcasecmp(p->name, name) != 0)
            continue;
        int idx = param_option_index(p, prefix);
        if (idx < 0) {
            fprintf(stderr, "crsf-param: \"%s\" has no option starting with \"%s\" (options: %s)\n",
                    p->name, prefix, p->options);
            return 1;
        }
        char before[96], after[96];
        format_value(p, before, sizeof before);
        uint8_t buf[16];
        if (send_frame(t, buf, crsf_build_param_write(buf, sizeof buf, CRSF_ADDR_MODULE, (uint8_t)id,
                                                      (uint8_t)idx)) < 0 ||
            pump(t, 300) < 0 || read_field(t, (uint8_t)id) < 0)
            return 2;
        format_value(p, after, sizeof after);
        printf("%s: %s -> %s\n", p->name, before, after);
        return p->value == idx ? 0 : 1;
    }
    fprintf(stderr, "crsf-param: no selectable setting named \"%s\" (try: list)\n", name);
    return 1;
}

int main(int argc, char **argv)
{
    int baud = 921600, opt;
    while ((opt = getopt(argc, argv, "b:")) != -1) {
        if (opt != 'b')
            goto usage;
        baud = atoi(optarg);
    }
    int rest = argc - optind;
    if (rest < 2 || baud <= 0)
        goto usage;
    const char *dev = argv[optind], *cmd = argv[optind + 1];
    bool is_list = !strcmp(cmd, "list") && rest == 2;
    bool is_set = !strcmp(cmd, "set") && rest == 4;
    if (!is_list && !is_set)
        goto usage;

    static tool_t t;
    t.fd = serial_open(dev, baud);
    if (t.fd < 0) {
        fprintf(stderr, "crsf-param: %s: %s\n", dev, strerror(errno));
        return 2;
    }
    crsf_deframer_init(&t.d);
    uint16_t ch[CRSF_NUM_CHANNELS];
    for (int i = 0; i < CRSF_NUM_CHANNELS; i++)
        ch[i] = crsf_us_to_ch(1000);         /* throttle and AUX low: disarmed */
    ch[0] = ch[1] = ch[3] = CRSF_CH_MID;
    crsf_build_rc_frame(t.rc, ch);

    int rc = find_module(&t);
    if (rc != 0) {
        fprintf(stderr, rc < 0 ? "crsf-param: I/O error\n" : "crsf-param: no TX module answered\n");
        close(t.fd);
        return rc < 0 ? 2 : 1;
    }
    printf("%s, ExpressLRS %u.%u.%u, %u settings\n", t.device.name, t.device.sw_major,
           t.device.sw_minor, t.device.sw_patch, t.device.field_count);
    rc = is_list ? cmd_list(&t) : cmd_set(&t, argv[optind + 2], argv[optind + 3]);
    close(t.fd);
    return rc;

usage:
    fprintf(stderr, "usage: crsf-param [-b baud] <device> list\n"
                    "       crsf-param [-b baud] <device> set \"<setting>\" <option>\n");
    return 2;
}
