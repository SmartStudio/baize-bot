"""网页终端的伪终端助手：python3 -I pty-helper.py <程序> [参数...]

stdin 原样写进伪终端，伪终端的输出原样写到 stdout；fd 3 每行一条 `cols rows` 改窗口大小。
stdin 读到头、收到 SIGHUP 或 SIGTERM，都给子进程那一组发 SIGHUP，和关掉真终端窗口一样；
2 秒内没退就给那一组 SIGKILL，然后自己退出。子进程退出后以它的退出码退出。只用标准库，不引原生模块。
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

CONTROL_FD = 3
CHUNK = 65536
KILL_AFTER = 2.0


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data) :]


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("pty-helper: 没给要跑的程序\n")
        return 2
    # fd 3 是从 node 继承来的，PEP 446 管不到它，不关掉的话终端里的程序也拿得到改窗口的管道。
    try:
        os.set_inheritable(CONTROL_FD, False)
    except OSError:
        pass
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)

    kill_at = None
    # select 被信号打断后按原来的超时重试，没超时就一直等；自写一个字节把循环叫醒，好开始计时。
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_w, False)

    def hangup(*_):
        nonlocal kill_at
        if kill_at is not None:
            return
        kill_at = time.monotonic() + KILL_AFTER
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.write(wake_w, b"x")
        except OSError:
            pass

    signal.signal(signal.SIGHUP, hangup)
    signal.signal(signal.SIGTERM, hangup)
    set_size(master, 80, 24)
    os.set_blocking(master, False)

    stdin_open = True
    control_open = True
    try:
        os.fstat(CONTROL_FD)
    except OSError:
        control_open = False
    control_buf = b""
    pending = b""

    while True:
        timeout = None
        if kill_at is not None:
            timeout = kill_at - time.monotonic()
            if timeout <= 0:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except OSError:
                    pass
                break
        readers = [master, wake_r]
        if stdin_open and not pending:
            readers.append(0)
        if control_open:
            readers.append(CONTROL_FD)
        writers = [master] if pending else []
        try:
            readable, writable, _ = select.select(readers, writers, [], timeout)
        except InterruptedError:
            continue

        if wake_r in readable:
            os.read(wake_r, 64)

        if master in writable and pending:
            try:
                pending = pending[os.write(master, pending) :]
            except BlockingIOError:
                pass
            except OSError:
                pending = b""

        if master in readable:
            try:
                data = os.read(master, CHUNK)
            except BlockingIOError:
                data = None
            except OSError as error:
                # Linux 上子进程那一端全关了 read 报 EIO，macOS 上读到空。
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data == b"":
                break
            if data:
                write_all(1, data)

        if 0 in readable:
            data = os.read(0, CHUNK)
            if data:
                pending += data
            else:
                stdin_open = False
                hangup()

        if CONTROL_FD in readable:
            data = os.read(CONTROL_FD, 1024)
            if not data:
                control_open = False
            control_buf += data
            *lines, control_buf = control_buf.split(b"\n")
            for line in lines:
                parts = line.split()
                if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                    set_size(master, int(parts[0]), int(parts[1]))

    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
