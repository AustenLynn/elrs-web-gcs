/* evlog.h - event log (JSON lines) and per-frame timing log (CSV). Written by the IPC
 * thread only; the frame loop never touches files. These logs are the evidence for
 * the jitter (C1) and failsafe (C3) criteria. */
#ifndef EVLOG_H
#define EVLOG_H

#include <stdio.h>
#include "mailbox.h"

typedef struct {
    FILE *events;   /* NULL = disabled */
    FILE *timing;   /* NULL = disabled */
} evlog_t;

/* Empty paths disable that log. Returns 0, or -1 with a message in err. */
int evlog_open(evlog_t *e, const char *events_path, const char *timing_path, char *err, size_t errlen);
/* Appends the event to the JSON log and prints important ones to stderr (journald). */
void evlog_event(evlog_t *e, const core_event_t *ev);
void evlog_timing(evlog_t *e, const timing_sample_t *t);
void evlog_flush(evlog_t *e);
void evlog_close(evlog_t *e);

/* One event as a single-line JSON object. `wall` is an ISO-8601 UTC time. */
size_t evlog_format(char *out, size_t cap, const core_event_t *ev, const char *wall);

#endif
