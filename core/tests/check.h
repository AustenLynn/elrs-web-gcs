/* check.h - minimal unit-test helpers. Each tests/test_*.c is its own program. */
#ifndef CHECK_H
#define CHECK_H

#include <stdio.h>
#include <string.h>

static int check_failures;

#define CHECK(cond) do { \
    if (!(cond)) { \
        fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        check_failures++; \
    } \
} while (0)

#define CHECK_EQ_INT(a, b) do { \
    long long check_a_ = (long long)(a), check_b_ = (long long)(b); \
    if (check_a_ != check_b_) { \
        fprintf(stderr, "%s:%d: CHECK_EQ_INT failed: %s == %s (%lld != %lld)\n", \
                __FILE__, __LINE__, #a, #b, check_a_, check_b_); \
        check_failures++; \
    } \
} while (0)

#define CHECK_MEM(a, b, n) do { \
    if (memcmp((a), (b), (n)) != 0) { \
        fprintf(stderr, "%s:%d: CHECK_MEM failed: %s vs %s\n", __FILE__, __LINE__, #a, #b); \
        check_failures++; \
    } \
} while (0)

#define CHECK_STR(a, b) do { \
    if (strcmp((a), (b)) != 0) { \
        fprintf(stderr, "%s:%d: CHECK_STR failed: \"%s\" != \"%s\"\n", __FILE__, __LINE__, (a), (b)); \
        check_failures++; \
    } \
} while (0)

#define RUN(test) do { \
    int check_before_ = check_failures; \
    test(); \
    printf("%s %s\n", check_failures == check_before_ ? "PASS" : "FAIL", #test); \
} while (0)

#define CHECK_EXIT() (check_failures == 0 ? 0 : 1)

#endif
