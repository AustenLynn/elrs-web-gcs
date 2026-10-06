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

static void close_observer(int *fd)
{
    close(*fd);
    *fd = -1;
}

/* Sends one message to one connection. fd = &s->client_fd for the gateway, or an
 * observer slot. */
static void send_to(ipcserver_t *s, int *fd, const uint8_t *buf, size_t len)
{
    if (*fd < 0 || len == 0)
        return;
    ssize_t w = send(*fd, buf, len, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (w == (ssize_t)len)
        return;
    if (w < 0 && (errno == EAGAIN || errno == EINTR)) {
        s->send_dropped++;       /* reader is slow: drop this message, keep framing intact */
        return;
    }
    /* error or partial write: the stream is no longer usable */
    if (fd == &s->client_fd)
        drop_client(s);
    else
        close_observer(fd);
}

/* Sends to the gateway and every observer. */
static void send_msg(ipcserver_t *s, const uint8_t *buf, size_t len)
{
    send_to(s, &s->client_fd, buf, len);
    for (int i = 0; i < IPC_MAX_OBSERVERS; i++)
        send_to(s, &s->obs_fd[i], buf, len);
}

/* fd = NULL: everyone; otherwise only that connection (a newcomer catching up). */
static void send_telemetry(ipcserver_t *s, unsigned bits, int *fd)
{
    size_t n[4] = { 0 };
    uint8_t msgs[4][64];
    if (bits & MB_DIRTY_LINK)
        n[0] = ipc_encode_link(msgs[0], sizeof msgs[0], &s->link);
    if (bits & MB_DIRTY_BATTERY)
        n[1] = ipc_encode_battery(msgs[1], sizeof msgs[1], &s->battery);
    if (bits & MB_DIRTY_FMODE)
        n[2] = ipc_encode_flight_mode(msgs[2], sizeof msgs[2], s->flight_mode);
    if (bits & MB_DIRTY_DEVICE)
        n[3] = ipc_encode_device(msgs[3], sizeof msgs[3], &s->device);
    for (int i = 0; i < 4; i++) {
        if (fd)
            send_to(s, fd, msgs[i], n[i]);
        else
            send_msg(s, msgs[i], n[i]);
    }
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
    if (!ok || !mailbox_push_cmd(s->mb, &c))
        s->bad_msg = true;      /* malformed, or a command we could not queue: drop the gateway */
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
    send_telemetry(s, s->have, &s->client_fd);  /* bring the new gateway up to date */
}

static void accept_observer(ipcserver_t *s)
{
    int fd = accept4(s->status_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (fd < 0)
        return;
    for (int i = 0; i < IPC_MAX_OBSERVERS; i++) {
        if (s->obs_fd[i] < 0) {
            s->obs_fd[i] = fd;
            send_telemetry(s, s->have, &s->obs_fd[i]);
            return;
        }
    }
    close(fd);                   /* full: observers never push anyone out */
}

/* Observers are read-only: whatever they send is read and thrown away. */
static void read_observer(int *fd)
{
    uint8_t buf[256];
    ssize_t n = read(*fd, buf, sizeof buf);
    if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR))
        close_observer(fd);
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
    send_telemetry(s, bits, NULL);
}

static int listen_unix(const char *path, char *err, size_t errlen)
{
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    if (strlen(path) >= sizeof addr.sun_path) {
        snprintf(err, errlen, "%s: socket path too long", path);
        return -1;
    }
    strcpy(addr.sun_path, path);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        snprintf(err, errlen, "socket: %s", strerror(errno));
        return -1;
    }
    unlink(path);               /* stale socket from a previous run */
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0 ||
        chmod(path, 0660) < 0 || listen(fd, 4) < 0) {
        snprintf(err, errlen, "%s: %s", path, strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

int ipcserver_open(ipcserver_t *s, const config_t *cfg, mailbox_t *mb, evlog_t *log,
                   char *err, size_t errlen)
{
    memset(s, 0, sizeof *s);
    s->cfg = cfg;
    s->mb = mb;
    s->log = log;
    s->client_fd = -1;
    s->status_fd = -1;
    for (int i = 0; i < IPC_MAX_OBSERVERS; i++)
        s->obs_fd[i] = -1;

    s->listen_fd = listen_unix(cfg->socket_path, err, errlen);
    if (s->listen_fd < 0)
        return -1;
    if (cfg->status_socket_path[0] != '\0') {
        s->status_fd = listen_unix(cfg->status_socket_path, err, errlen);
        if (s->status_fd < 0) {
            close(s->listen_fd);
            unlink(cfg->socket_path);
            return -1;
        }
    }
    return 0;
}

void ipcserver_run(ipcserver_t *s, atomic_bool *stop)
{
    int64_t next_status = mono_ns();
    int64_t next_flush = next_status + NS_PER_S;
    while (!atomic_load(stop)) {
        /* Negative fds are ignored by poll(): fixed slots, no bookkeeping. */
        struct pollfd p[3 + IPC_MAX_OBSERVERS] = {
            { .fd = s->listen_fd, .events = POLLIN },
            { .fd = s->client_fd, .events = POLLIN },
            { .fd = s->status_fd, .events = POLLIN },
        };
        for (int i = 0; i < IPC_MAX_OBSERVERS; i++)
            p[3 + i] = (struct pollfd){ .fd = s->obs_fd[i], .events = POLLIN };
        const short ready = POLLIN | POLLHUP | POLLERR;
        if (poll(p, 3 + IPC_MAX_OBSERVERS, 20) > 0) {
            if (p[1].fd >= 0 && (p[1].revents & ready))
                read_client(s);
            if (p[0].revents & POLLIN)
                accept_client(s);
            for (int i = 0; i < IPC_MAX_OBSERVERS; i++)
                if (p[3 + i].fd >= 0 && p[3 + i].fd == s->obs_fd[i] && (p[3 + i].revents & ready))
                    read_observer(&s->obs_fd[i]);
            if (p[2].fd >= 0 && (p[2].revents & POLLIN))
                accept_observer(s);
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
    for (int i = 0; i < IPC_MAX_OBSERVERS; i++)
        if (s->obs_fd[i] >= 0)
            close(s->obs_fd[i]);
    if (s->listen_fd >= 0) {
        close(s->listen_fd);
        unlink(s->cfg->socket_path);
    }
    if (s->status_fd >= 0) {
        close(s->status_fd);
        unlink(s->cfg->status_socket_path);
    }
}
