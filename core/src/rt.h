/* rt.h - real-time settings for the frame loop: locked memory, SCHED_FIFO, CPU pinning. */
#ifndef RT_H
#define RT_H

#include <pthread.h>
#include <stddef.h>

/* mlockall(): no page faults (swapping, lazy allocation) inside the frame loop. */
int rt_lock_memory(char *err, size_t errlen);
/* Thread attributes: SCHED_FIFO at `priority` (0 = normal scheduling), pinned to `cpu`
 * (-1 = any CPU), 256 KiB stack. pthread_create() fails with EPERM if not allowed. */
int rt_thread_attr(pthread_attr_t *attr, int cpu, int priority, char *err, size_t errlen);
/* Touch the stack once so its pages exist before the first deadline. */
void rt_prefault_stack(void);

#endif
