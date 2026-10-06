/* serial.h - open a serial port in raw 8N1 mode at any baud rate (Linux termios2). */
#ifndef SERIAL_H
#define SERIAL_H

/* Opens `path` non-blocking, raw, 8N1, no flow control, at `baud` (any value the
 * driver accepts, e.g. 921600), and takes an exclusive lock (TIOCEXCL) so a second
 * program cannot open the same port. Returns the fd, or -1 with errno set. */
int serial_open(const char *path, int baud);

#endif
