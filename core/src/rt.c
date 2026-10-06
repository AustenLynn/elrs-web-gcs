#define _GNU_SOURCE
#include "rt.h"

#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

int rt_lock_memory(char *err, size_t errlen)
{
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        snprintf(err, errlen, "mlockall: %s", strerror(errno));
        return -1;
    }
    return 0;
}

int rt_thread_attr(pthread_attr_t *attr, int cpu, int priority, char *err, size_t errlen)
{
    int rc = pthread_attr_init(attr);
    if (rc == 0)
        rc = pthread_attr_setstacksize(attr, 256 * 1024);
    if (rc == 0 && priority > 0) {
        struct sched_param sp = { .sched_priority = priority };
        rc = pthread_attr_setinheritsched(attr, PTHREAD_EXPLICIT_SCHED);
        if (rc == 0)
            rc = pthread_attr_setschedpolicy(attr, SCHED_FIFO);
        if (rc == 0)
            rc = pthread_attr_setschedparam(attr, &sp);
    }
    if (rc == 0 && cpu >= 0) {
        cpu_set_t set;
        CPU_ZERO(&set);
        CPU_SET(cpu, &set);
        rc = pthread_attr_setaffinity_np(attr, sizeof set, &set);
    }
    if (rc != 0) {
        snprintf(err, errlen, "thread attributes: %s", strerror(rc));
        return -1;
    }
    return 0;
}

void rt_prefault_stack(void)
{
    volatile unsigned char buf[64 * 1024];
    for (size_t i = 0; i < sizeof buf; i += 4096)
        buf[i] = 0;
}
