/* config.h - crsf-core settings, loaded from a "key = value" file. */
#ifndef CONFIG_H
#define CONFIG_H

#include <stdbool.h>
#include <stddef.h>

#define CONFIG_PATH_MAX 256

typedef struct {
    char serial_device[CONFIG_PATH_MAX];
    int baud;
    char socket_path[CONFIG_PATH_MAX];
    char event_log[CONFIG_PATH_MAX];   /* JSON lines; "" = disabled */
    char timing_log[CONFIG_PATH_MAX];  /* per-frame CSV; "" = disabled */
    int default_period_us;             /* frame period until the module sends timing frames */
    int sync_margin_us;                /* aim frames this much earlier than the module asks */
    int cmd_timeout_ms;                /* armed + no fresh command this long -> failsafe */
    int throttle_arm_max;              /* 0..1000; throttle must be <= this to arm or clear failsafe */
    int fc_armed_fresh_ms;             /* how long an "FC is armed" telemetry report stays valid */
    int model_id;                      /* ELRS model slot selected at start-up */
    int rt_priority;                   /* SCHED_FIFO priority of the frame loop; 0 = leave as is */
    int rt_cpu;                        /* CPU the frame loop is pinned to; -1 = no pinning */
    bool rt_required;                  /* refuse to run if real-time setup fails */
    int stick_min_us;
    int stick_max_us;
    /* 0-based channel indexes. The file uses 1-based numbers (ch_arm = 5 means CH5). */
    int ch_roll, ch_pitch, ch_throttle, ch_yaw, ch_arm, ch_mode, ch_failsafe;
} config_t;

void config_defaults(config_t *c);
/* Applies one setting. Returns 0, or -1 with a message in err. */
int config_set(config_t *c, const char *key, const char *value, char *err, size_t errlen);
/* Cross-field checks. Returns 0, or -1 with a message in err. */
int config_validate(const config_t *c, char *err, size_t errlen);
/* Reads "key = value" lines ('#' starts a comment) over the current values, then validates. */
int config_load(config_t *c, const char *path, char *err, size_t errlen);

#endif
