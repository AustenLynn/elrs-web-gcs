/* crsf-ctl - talk to crsf-core over its socket, for bench tests without the gateway.
 *
 *   crsf-ctl [-s socket] status   print one status line
 *   crsf-ctl [-s socket] watch    print status, telemetry and refusals until Ctrl-C
 *   crsf-ctl [-s socket] pilot    keyboard pilot: a=arm d=disarm k=ack f=failsafe
 *                                 w/s=throttle +/-50  x=stop/resume sending  q=quit
 * PROPELLERS OFF: `pilot` really arms the aircraft. */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include "ipc_proto.h"
#include "safety.h"
#include "timeutil.h"

typedef struct {
    bool have_status;
    ipc_status_t st;
    char fm[16];
    bool verbose;           /* print telemetry and events as they arrive */
    char last_event[96];
    int64_t last_link_print;
} ctl_t;

static volatile sig_atomic_t quit;
static struct termios saved_tio;
static bool raw_tty;

static void on_sigint(int sig)
{
    (void)sig;
    quit = 1;
}

static void restore_tty(void)
{
    if (raw_tty)
        tcsetattr(STDIN_FILENO, TCSANOW, &saved_tio);
}

static const char *fc_name(uint8_t v)
{
    return v == FC_ARMED ? "armed" : v == FC_DISARMED ? "disarmed" : "unknown";
}

static void format_status(const ipc_status_t *s, char *out, size_t cap)
{
    char age[16];
    if (s->cmd_age_ms == IPC_NO_CMD_AGE)
        snprintf(age, sizeof age, "none");
    else
        snprintf(age, sizeof age, "%ums", s->cmd_age_ms);
    snprintf(out, cap,
             "%-8s reason=%-15s session=%u seq=%u cmd_age=%s serial=%s frames=%u period=%uus "
             "offset=%+.1fus late_max=%uus fc=%s ch5=%u ch7=%u",
             safety_state_name((safety_state_t)s->state), safety_reason_name((fs_reason_t)s->fs_reason),
             s->session, s->last_seq, age, s->serial_ok ? "ok" : "DOWN", s->frames_sent, s->period_us,
             s->offset_0p1us / 10.0, s->wake_late_max_us, fc_name(s->fc_arm), s->channels[4], s->channels[6]);
}

static void on_msg(uint8_t type, const uint8_t *p, size_t n, void *user)
{
    ctl_t *c = user;
    switch (type) {
    case IPC_STATUS:
        if (ipc_decode_status(p, n, &c->st) == 0)
            c->have_status = true;
        break;
    case IPC_FLIGHT_MODE:
        if (n >= 1 && (size_t)p[0] + 1 <= n && p[0] < sizeof c->fm) {
            memcpy(c->fm, p + 1, p[0]);
            c->fm[p[0]] = '\0';
            if (c->verbose)
                printf("flight mode: %s\n", c->fm);
        }
        break;
    case IPC_LINK:          /* up_rssi1, up_rssi2, up_lq, up_snr, antenna, rf_mode, u16 power, dn_rssi, dn_lq, dn_snr */
        if (c->verbose && n == 11 && mono_ns() - c->last_link_print >= NS_PER_S) {
            c->last_link_print = mono_ns();
            printf("link: uplink LQ %u%% RSSI %d dBm, downlink LQ %u%% RSSI %d dBm, %u mW\n", p[2],
                   (int8_t)p[0], p[9], (int8_t)p[8], (unsigned)(p[6] | p[7] << 8));
        }
        break;
    case IPC_BATTERY:
        if (c->verbose && n == 9)
            printf("battery: %.1f V, %u%%\n", (p[0] | p[1] << 8) / 10.0, p[8]);
        break;
    case IPC_DEVICE:
        if (c->verbose && n >= 9)
            printf("module: %.*s firmware %u.%u.%u\n", p[8], (const char *)p + 9, p[1], p[2], p[3]);
        break;
    case IPC_EVENT:
        if (n == 6)
            snprintf(c->last_event, sizeof c->last_event, "%s refused: %s",
                     p[0] == IPC_EVENT_ARM_REFUSED ? "arm" : "ack", safety_refuse_name((refuse_t)p[1]));
        if (c->verbose)
            printf("%s\n", c->last_event);
        break;
    default:
        break;
    }
    fflush(stdout);
}

static int connect_core(const char *path)
{
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    snprintf(addr.sun_path, sizeof addr.sun_path, "%s", path);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        fprintf(stderr, "crsf-ctl: %s: %s\n", path, strerror(errno));
        return -1;
    }
    return fd;
}

/* Waits up to timeout_ms for socket data and feeds it to the reader. -1 = connection lost. */
static int pump(int fd, ipc_reader_t *r, ctl_t *c, int timeout_ms)
{
    struct pollfd p = { .fd = fd, .events = POLLIN };
    if (poll(&p, 1, timeout_ms) <= 0)
        return 0;
    uint8_t buf[1024];
    ssize_t n = read(fd, buf, sizeof buf);
    if (n <= 0 || ipc_reader_feed(r, buf, (size_t)n, on_msg, c) < 0)
        return -1;
    return 0;
}

static int cmd_status(int fd)
{
    ctl_t c = { 0 };
    ipc_reader_t r;
    ipc_reader_init(&r);
    int64_t end = mono_ns() + NS_PER_S;
    while (!c.have_status && mono_ns() < end)
        if (pump(fd, &r, &c, 100) < 0)
            break;
    if (!c.have_status) {
        fprintf(stderr, "crsf-ctl: no status from crsf-core\n");
        return 1;
    }
    char line[400];
    format_status(&c.st, line, sizeof line);
    printf("%s\n", line);
    return 0;
}

static int cmd_watch(int fd)
{
    ctl_t c = { .verbose = true };
    ipc_reader_t r;
    ipc_reader_init(&r);
    int64_t next = mono_ns();
    while (!quit) {
        if (pump(fd, &r, &c, 100) < 0) {
            fprintf(stderr, "crsf-ctl: connection closed\n");
            return 1;
        }
        if (c.have_status && mono_ns() >= next) {
            char line[400];
            format_status(&c.st, line, sizeof line);
            printf("%s\n", line);
            fflush(stdout);
            next = mono_ns() + NS_PER_S;
        }
    }
    return 0;
}

static void send_session_msg(int fd, uint8_t type, uint32_t session)
{
    uint8_t buf[16];
    size_t n = ipc_encode_session_msg(buf, sizeof buf, type, session);
    if (write(fd, buf, n) < 0)
        quit = 1;
}

static int cmd_pilot(int fd)
{
    if (tcgetattr(STDIN_FILENO, &saved_tio) == 0) {
        struct termios raw = saved_tio;
        raw.c_lflag &= (tcflag_t)~(ICANON | ECHO);
        raw.c_cc[VMIN] = 0;
        raw.c_cc[VTIME] = 0;
        if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0) {
            raw_tty = true;
            atexit(restore_tty);
        }
    }
    srand((unsigned)(time(NULL) ^ getpid()));
    uint32_t session = (uint32_t)rand() | 1u;
    send_session_msg(fd, IPC_SESSION, session);
    printf("pilot session %u. a=arm d=disarm k=ack f=failsafe w/s=throttle x=stop/resume q=quit\n", session);

    ctl_t c = { 0 };
    ipc_reader_t r;
    ipc_reader_init(&r);
    ipc_control_t ctl = { .session = session };
    bool sending = true;
    int64_t next_send = mono_ns(), next_print = next_send;

    while (!quit) {
        int64_t now = mono_ns();
        if (now >= next_send) {
            if (sending) {
                uint8_t buf[32];
                ctl.seq++;
                size_t n = ipc_encode_control(buf, sizeof buf, &ctl);
                if (write(fd, buf, n) < 0)
                    break;
            }
            next_send = now + 20 * NS_PER_MS;        /* 50 Hz, like the web app */
        }
        struct pollfd p[2] = { { .fd = fd, .events = POLLIN }, { .fd = STDIN_FILENO, .events = POLLIN } };
        int timeout = (int)((next_send - mono_ns()) / NS_PER_MS);
        if (poll(p, 2, timeout < 0 ? 0 : timeout) > 0) {
            if (p[0].revents & (POLLIN | POLLHUP)) {
                uint8_t buf[1024];
                ssize_t n = read(fd, buf, sizeof buf);
                if (n <= 0 || ipc_reader_feed(&r, buf, (size_t)n, on_msg, &c) < 0) {
                    fprintf(stderr, "\ncrsf-ctl: connection closed\n");
                    return 1;
                }
            }
            char key;
            if ((p[1].revents & POLLIN) && read(STDIN_FILENO, &key, 1) == 1) {
                switch (key) {
                case 'a': send_session_msg(fd, IPC_ARM, session); break;
                case 'd': send_session_msg(fd, IPC_DISARM, session); break;
                case 'k': send_session_msg(fd, IPC_ACK, session); break;
                case 'f': send_session_msg(fd, IPC_FAILSAFE, session); break;
                case 'w': ctl.sticks.throttle = (uint16_t)(ctl.sticks.throttle >= 950 ? 1000 : ctl.sticks.throttle + 50); break;
                case 's': ctl.sticks.throttle = (uint16_t)(ctl.sticks.throttle <= 50 ? 0 : ctl.sticks.throttle - 50); break;
                case 'x': sending = !sending; break;
                case 'q': quit = 1; break;
                default: break;
                }
            }
        }
        if (c.have_status && mono_ns() >= next_print) {
            printf("\r%-8s %-15s throttle=%4u sending=%s fc=%-8s %s %-30s",
                   safety_state_name((safety_state_t)c.st.state),
                   safety_reason_name((fs_reason_t)c.st.fs_reason), ctl.sticks.throttle,
                   sending ? "yes" : "NO ", fc_name(c.st.fc_arm), c.fm, c.last_event);
            fflush(stdout);
            next_print = mono_ns() + 200 * NS_PER_MS;
        }
    }
    printf("\n");
    return 0;
}

int main(int argc, char **argv)
{
    /* status and watch only read, so they use crsf-core's read-only status socket and are
     * safe while flying. pilot is a gateway: it takes over the control socket, and an
     * armed aircraft fails safe when it does. */
    const char *path = NULL;
    int opt;
    while ((opt = getopt(argc, argv, "s:")) != -1) {
        if (opt != 's') {
            fprintf(stderr, "usage: crsf-ctl [-s socket] status|watch|pilot\n");
            return 2;
        }
        path = optarg;
    }
    if (optind != argc - 1) {
        fprintf(stderr, "usage: crsf-ctl [-s socket] status|watch|pilot\n");
        return 2;
    }
    const char *cmd = argv[optind];
    if (!path)
        path = strcmp(cmd, "pilot") == 0 ? "/run/crsf-core/core.sock" : "/run/crsf-core/status.sock";
    signal(SIGINT, on_sigint);
    signal(SIGPIPE, SIG_IGN);
    int fd = connect_core(path);
    if (fd < 0)
        return 1;
    int rc;
    if (!strcmp(cmd, "status"))
        rc = cmd_status(fd);
    else if (!strcmp(cmd, "watch"))
        rc = cmd_watch(fd);
    else if (!strcmp(cmd, "pilot"))
        rc = cmd_pilot(fd);
    else {
        fprintf(stderr, "crsf-ctl: unknown command \"%s\"\n", cmd);
        rc = 2;
    }
    close(fd);
    return rc;
}
