/* timeutil.h - CLOCK_MONOTONIC helpers shared by the core and the tools. */
#ifndef TIMEUTIL_H
#define TIMEUTIL_H

#include <stdint.h>
#include <time.h>

#define NS_PER_US 1000LL
#define NS_PER_MS 1000000LL
#define NS_PER_S  1000000000LL

static inline int64_t mono_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * NS_PER_S + ts.tv_nsec;
}

static inline struct timespec ns_to_timespec(int64_t ns)
{
    struct timespec ts = { .tv_sec = ns / NS_PER_S, .tv_nsec = ns % NS_PER_S };
    return ts;
}

#endif
