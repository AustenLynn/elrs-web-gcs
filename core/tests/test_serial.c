#define _GNU_SOURCE
#include "check.h"
#include "serial.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

/* Uses a pseudo-terminal pair so the test runs without hardware. */
static int open_pty(char *name, size_t cap)
{
    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0 || grantpt(master) < 0 || unlockpt(master) < 0)
        return -1;
    if (ptsname_r(master, name, cap) != 0)
        return -1;
    return master;
}

static void test_open_configures_raw_port(void)
{
    char name[64];
    int master = open_pty(name, sizeof name);
    CHECK(master >= 0);
    int fd = serial_open(name, 921600);
    CHECK(fd >= 0);

    static const uint8_t frame[] = { 0xEE, 0x04, 0x28, 0x00, 0xEA, 0x54 };
    CHECK_EQ_INT(write(fd, frame, sizeof frame), sizeof frame);
    uint8_t got[16];
    usleep(20000);
    CHECK_EQ_INT(read(master, got, sizeof got), sizeof frame); /* raw: no byte translation */
    CHECK_MEM(got, frame, sizeof frame);

    /* With VMIN=0/VTIME=0 an empty tty read returns 0 at once (never blocks). A real
     * USB serial port behaves the same, so unplugging is detected by write() errors. */
    uint8_t buf[4];
    errno = 0;
    ssize_t r = read(fd, buf, sizeof buf);
    CHECK(r == 0 || (r == -1 && errno == EAGAIN));
    close(fd);
    close(master);
}

static void test_second_open_is_refused(void)
{
    char name[64];
    int master = open_pty(name, sizeof name);
    int fd = serial_open(name, 921600);
    CHECK(fd >= 0);
    CHECK_EQ_INT(serial_open(name, 921600), -1);     /* TIOCEXCL: e.g. crsf-param while crsf-core runs */
    CHECK_EQ_INT(errno, EBUSY);
    close(fd);
    close(master);
}

static void test_missing_device_fails(void)
{
    CHECK_EQ_INT(serial_open("/dev/does-not-exist", 921600), -1);
    CHECK_EQ_INT(errno, ENOENT);
}

int main(void)
{
    RUN(test_open_configures_raw_port);
    RUN(test_second_open_is_refused);
    RUN(test_missing_device_fails);
    return CHECK_EXIT();
}
