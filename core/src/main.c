/* crsf-core - real-time bridge between the gateway (Unix socket) and an ELRS TX module.
 *
 *   crsf-core [-c /etc/gcs/crsf-core.conf] */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "config.h"
#include "evlog.h"
#include "ipcserver.h"
#include "mailbox.h"
#include "rt.h"
#include "rtloop.h"
#include "timeutil.h"

#define CRSF_CORE_VERSION "0.1.0"

static atomic_bool stop_flag;
static mailbox_t mb;
static ipcserver_t ipc;
static rtloop_t loop;

static void on_signal(int sig)
{
    (void)sig;
    atomic_store(&stop_flag, true);
}

static int start_loop(const config_t *cfg, pthread_t *th)
{
    char err[256];
    pthread_attr_t attr;
    int rc = -1;
    if (rt_thread_attr(&attr, cfg->rt_cpu, cfg->rt_priority, err, sizeof err) == 0) {
        rc = pthread_create(th, &attr, rtloop_run, &loop);
        pthread_attr_destroy(&attr);
        if (rc != 0)
            snprintf(err, sizeof err, "frame loop on cpu %d with SCHED_FIFO %d: %s",
                     cfg->rt_cpu, cfg->rt_priority, strerror(rc));
    }
    if (rc == 0)
        return 0;
    if (cfg->rt_required) {
        fprintf(stderr, "crsf-core: %s\n", err);
        return -1;
    }
    fprintf(stderr, "crsf-core: warning: %s; running without real-time settings\n", err);
    rc = pthread_create(th, NULL, rtloop_run, &loop);
    if (rc != 0) {
        fprintf(stderr, "crsf-core: frame loop: %s\n", strerror(rc));
        return -1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    const char *config_path = "/etc/gcs/crsf-core.conf";
    int opt;
    while ((opt = getopt(argc, argv, "c:")) != -1) {
        if (opt != 'c') {
            fprintf(stderr, "usage: crsf-core [-c config]\n");
            return 2;
        }
        config_path = optarg;
    }

    config_t cfg;
    char err[512];
    config_defaults(&cfg);
    if (config_load(&cfg, config_path, err, sizeof err) != 0) {
        fprintf(stderr, "crsf-core: %s\n", err);
        return 2;
    }

    struct sigaction sa = { .sa_handler = on_signal };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    evlog_t log;
    if (evlog_open(&log, cfg.event_log, cfg.timing_log, err, sizeof err) != 0) {
        fprintf(stderr, "crsf-core: %s\n", err);
        return 2;
    }
    if (mailbox_init(&mb) != 0) {
        fprintf(stderr, "crsf-core: cannot create mailbox mutex\n");
        return 1;
    }
    if (cfg.rt_priority > 0 && rt_lock_memory(err, sizeof err) != 0) {
        if (cfg.rt_required) {
            fprintf(stderr, "crsf-core: %s\n", err);
            return 1;
        }
        fprintf(stderr, "crsf-core: warning: %s\n", err);
    }
    if (ipcserver_open(&ipc, &cfg, &mb, &log, err, sizeof err) != 0) {
        fprintf(stderr, "crsf-core: %s\n", err);
        return 1;
    }

    rtloop_init(&loop, &cfg, &mb, &stop_flag);
    pthread_t th;
    if (start_loop(&cfg, &th) != 0) {
        ipcserver_close(&ipc);
        return 1;
    }

    core_event_t start = { .kind = EV_START, .t_ns = mono_ns() };
    snprintf(start.text, sizeof start.text, "%s", CRSF_CORE_VERSION);
    evlog_event(&log, &start);
    fprintf(stderr, "crsf-core: %s at %d baud, socket %s, failsafe after %d ms\n",
            cfg.serial_device, cfg.baud, cfg.socket_path, cfg.cmd_timeout_ms);

    ipcserver_run(&ipc, &stop_flag);

    pthread_join(th, NULL);
    ipcserver_close(&ipc);
    evlog_close(&log);
    mailbox_destroy(&mb);
    return 0;
}
