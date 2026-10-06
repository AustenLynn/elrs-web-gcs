/* ipcserver.h - Unix-socket server for the gateway (runs in the main, non-real-time
 * thread). Forwards gateway commands into the mailbox; sends status (10 Hz),
 * telemetry and refusals back; writes the event and timing logs. One gateway at a
 * time: a new connection replaces the old one (treated as "gateway lost").
 * A second, read-only socket (status_socket_path) serves up to IPC_MAX_OBSERVERS
 * observers such as crsf-ctl status/watch: they get the same status, telemetry and
 * events, anything they send is ignored, and they never affect the gateway. */
#ifndef IPCSERVER_H
#define IPCSERVER_H

#include <stdatomic.h>
#include <stdbool.h>
#include "config.h"
#include "evlog.h"
#include "ipc_proto.h"
#include "mailbox.h"

#define IPC_MAX_OBSERVERS 4

typedef struct {
    const config_t *cfg;
    mailbox_t *mb;
    evlog_t *log;
    int listen_fd;
    int client_fd;
    int status_fd;                   /* read-only observer socket; -1 = disabled */
    int obs_fd[IPC_MAX_OBSERVERS];
    ipc_reader_t reader;
    bool bad_msg;
    crsf_link_stats_t link;          /* last telemetry, replayed to a new gateway */
    crsf_battery_t battery;
    char flight_mode[16];
    crsf_device_info_t device;
    unsigned have;                   /* MB_DIRTY_* bits we hold values for */
    uint32_t send_dropped;
} ipcserver_t;

int ipcserver_open(ipcserver_t *s, const config_t *cfg, mailbox_t *mb, evlog_t *log,
                   char *err, size_t errlen);
void ipcserver_run(ipcserver_t *s, atomic_bool *stop);
void ipcserver_close(ipcserver_t *s);

#endif
