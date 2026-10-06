#include "serial.h"

#include <asm/termbits.h>   /* struct termios2 and BOTHER; do not mix with <termios.h> */
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <unistd.h>

int serial_open(const char *path, int baud)
{
    int fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0)
        return -1;

    /* TIOCEXCL keeps other users out; flock() also stops root, which bypasses TIOCEXCL
     * (e.g. "sudo crsf-param" while crsf-core is flying). */
    if (flock(fd, LOCK_EX | LOCK_NB) < 0) {
        if (errno == EWOULDBLOCK)
            errno = EBUSY;
        goto fail;
    }
    struct termios2 tio;
    if (ioctl(fd, TIOCEXCL) < 0 || ioctl(fd, TCGETS2, &tio) < 0)
        goto fail;
    tio.c_cflag = CS8 | CREAD | CLOCAL | BOTHER;
    tio.c_iflag = 0;
    tio.c_oflag = 0;
    tio.c_lflag = 0;
    tio.c_cc[VMIN] = 0;
    tio.c_cc[VTIME] = 0;
    tio.c_ispeed = (speed_t)baud;
    tio.c_ospeed = (speed_t)baud;
    if (ioctl(fd, TCSETS2, &tio) < 0 || ioctl(fd, TCFLSH, TCIOFLUSH) < 0)
        goto fail;
    return fd;

fail:;
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
}
