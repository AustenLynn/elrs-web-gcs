#define _GNU_SOURCE
#include "ipcserver.h"

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "timeutil.h"

static void log_gateway(ipcserver_t *s, int connected)
{
    core_event_t ev = { .kind = EV_GATEWAY, .t_ns = mono_ns(), .a = connected };
    evlog_event(s->log, &ev);
}

static void drop_client(ipcserver_t *s)
{
    if (s->client_fd < 0)
        return;
    close(s->client_fd);
    s->client_fd = -1;
    core_cmd_t lost = { .kind = CMD_GATEWAY_LOST };
    mailbox_push_cmd(s->mb, &lost);
    log_gateway(s, 0);
}

static void send_msg(ipcserver_t *s, const uint8_t *buf, size_t len)
{
    if (s->client_fd < 0 || len == 0)
        return;
    ssize_t w = send(s->client_fd, buf, len, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (w == (ssize_t)len)
        return;
    if (w < 0 && (errno == EAGAIN || errno == EINTR)) {
        s->send_dropped++;       /* gateway is slow: drop this message, keep framing intact */
        return;
    }
    drop_client(s);              /* error or partial write: the stream is no longer usable */
}

static void send_telemetry(ipcserver_t *s, unsigned bits)
{
    uint8_t buf[64];
    if (bits & MB_DIRTY_LINK)
        send_msg(s, buf, ipc_encode_link(buf, sizeof buf, &s->link));
    if (bits & MB_DIRTY_BATTERY)
        send_msg(s, buf, ipc_encode_battery(buf, sizeof buf, &s->battery));
    if (bits & MB_DIRTY_FMODE)
        send_msg(s, buf, ipc_encode_flight_mode(buf, sizeof buf, s->flight_mode));
    if (bits & MB_DIRTY_DEVICE)
        send_msg(s, buf, ipc_encode_device(buf, sizeof buf, &s->device));
}

static void on_msg(uint8_t type, const uint8_t *p, size_t n, void *user)
{
    ipcserver_t *s = user;
    core_cmd_t c = { 0 };
    int ok;
    if (type == IPC_CONTROL) {
        ipc_control_t ctl;
        ok = ipc_decode_control(p, n, &ctl) == 0;
        c.kind = CMD_CONTROL;
        c.session = ctl.session;
        c.seq = ctl.seq;
        c.sticks = ctl.sticks;
    } else {
        ok = ipc_decode_session_msg(p, n, &c.session) == 0;
        switch (type) {
        case IPC_SESSION:    c.kind = CMD_SESSION; break;
        case IPC_ARM:        c.kind = CMD_ARM; break;
        case IPC_DISARM:     c.kind = CMD_DISARM; break;
        case IPC_ACK:        c.kind = CMD_ACK; break;
        case IPC_PILOT_LOST: c.kind = CMD_PILOT_LOST; break;
        case IPC_FAILSAFE:   c.kind = CMD_FAILSAFE; break;
        default:             ok = 0; break;
        }
    }
    if (!ok) {
        s->bad_msg = true;
        return;
    }
    mailbox_push_cmd(s->mb, &c);
}

static void accept_client(ipcserver_t *s)
{
    int fd = accept4(s->listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (fd < 0)
        return;
    drop_client(s);              /* the newest gateway wins */
    s->client_fd = fd;
    s->bad_msg = false;
    ipc_reader_init(&s->reader);
    log_gateway(s, 1);
    send_telemetry(s, s->have);  /* bring the new gateway up to date */
}

static void read_client(ipcserver_t *s)
{
    uint8_t buf[1024];
    ssize_t n = read(s->client_fd, buf, sizeof buf);
    if (n > 0) {
        if (ipc_reader_feed(&s->reader, buf, (size_t)n, on_msg, s) < 0 || s->bad_msg)
            drop_client(s);
    } else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
        drop_client(s);
    }
}

static void drain_events(ipcserver_t *s)
{
    core_event_t evs[64];
    size_t n;
    uint8_t buf[32];
    while ((n = mailbox_take_events(s->mb, evs, 64)) > 0) {
        for (size_t i = 0; i < n; i++) {
            evlog_event(s->log, &evs[i]);
            if (evs[i].kind == EV_REFUSED) {
                uint8_t kind = evs[i].a == CMD_ARM ? IPC_EVENT_ARM_REFUSED : IPC_EVENT_ACK_REFUSED;
                send_msg(s, buf, ipc_encode_event(buf, sizeof buf, kind, (uint8_t)evs[i].b, evs[i].session));
            }
        }
    }
}

static void drain_timing(ipcserver_t *s)
{
    timing_sample_t t[256];
    size_t n;
    while ((n = mailbox_take_timing(s->mb, t, 256)) > 0)
        for (size_t i = 0; i < n; i++)
            evlog_timing(s->log, &t[i]);
}

static void send_status(ipcserver_t *s)
{
    ipc_status_t st;
    uint8_t buf[128];
    mailbox_take_status(s->mb, &st);
    send_msg(s, buf, ipc_encode_status(buf, sizeof buf, &st));
    unsigned bits = mailbox_take_telemetry(s->mb, &s->link, &s->battery, s->flight_mode, &s->device);
    s->have |= bits;
    send_telemetry(s, bits);
}

int ipcserver_open(ipcserver_t *s, const config_t *cfg, mailbox_t *mb, evlog_t *log,
                   char *err, size_t errlen)
{
    memset(s, 0, sizeof *s);
    s->cfg = cfg;
    s->mb = mb;
    s->log = log;
    s->client_fd = -1;

    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    if (strlen(cfg->socket_path) >= sizeof addr.sun_path) {
        snprintf(err, errlen, "socket_path too long");
        return -1;
    }
    strcpy(addr.sun_path, cfg->socket_path);
    s->listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (s->listen_fd < 0) {
        snprintf(err, errlen, "socket: %s", strerror(errno));
        return -1;
    }
    unlink(cfg->socket_path);   /* stale socket from a previous run */
    if (bind(s->listen_fd, (struct sockaddr *)&addr, sizeof addr) < 0 ||
        chmod(cfg->socket_path, 0660) < 0 || listen(s->listen_fd, 4) < 0) {
        snprintf(err, errlen, "%s: %s", cfg->socket_path, strerror(errno));
        close(s->listen_fd);
        return -1;
    }
    return 0;
}

void ipcserver_run(ipcserver_t *s, atomic_bool *stop)
{
    int64_t next_status = mono_ns();
    int64_t next_flush = next_status + NS_PER_S;
    while (!atomic_load(stop)) {
        struct pollfd p[2] = {
            { .fd = s->listen_fd, .events = POLLIN },
            { .fd = s->client_fd, .events = POLLIN },
        };
        int nfds = s->client_fd >= 0 ? 2 : 1;
        if (poll(p, (nfds_t)nfds, 20) > 0) {
            if (p[0].revents & POLLIN)
                accept_client(s);
            else if (nfds == 2 && (p[1].revents & (POLLIN | POLLHUP | POLLERR)))
                read_client(s);
        }
        drain_events(s);
        drain_timing(s);
        int64_t now = mono_ns();
        if (now >= next_status) {
            send_status(s);
            next_status = now + 100 * NS_PER_MS;
        }
        if (now >= next_flush) {
            evlog_flush(s->log);
            next_flush = now + NS_PER_S;
        }
    }
    drain_events(s);
    drain_timing(s);
    evlog_flush(s->log);
}

void ipcserver_close(ipcserver_t *s)
{
    if (s->client_fd >= 0)
        close(s->client_fd);
    if (s->listen_fd >= 0) {
        close(s->listen_fd);
        unlink(s->cfg->socket_path);
    }
}
