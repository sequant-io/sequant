/*
 * #856 — identify who sends the kill, without dtrace.
 *
 * WHY THIS EXISTS
 *
 * AC-1 asks who sends the ~106s signal. The intended instrument was
 * `dtrace proc:::signal-send`, but on the affected machine SIP withholds that
 * provider outright:
 *
 *     dtrace: failed to match proc:::signal-send: System Integrity Protection is on
 *
 * Disabling SIP to debug a bug is a bad trade. Fortunately the kernel already
 * tells the *victim* who signalled it: a handler installed with SA_SIGINFO
 * receives a siginfo_t whose `si_pid` is the sending process (see
 * MacOSX.sdk/usr/include/sys/signal.h:182). No privileges required — you are
 * simply reading your own signal's metadata.
 *
 * This is only viable because the recovered stdout of a killed run
 * (tasks/b6byn5iih.output) shows `Received SIGTERM` — i.e. the first signal is
 * CATCHABLE. A pure SIGKILL would be unobservable this way, and the SIGKILL
 * that follows still is; what we capture is the sender of the TERM that
 * precedes it, which is the same actor.
 *
 * HOW IT WORKS
 *
 * The canary execs the real command as a child in the SAME process group, so a
 * group-directed signal hits both. On SIGTERM/SIGINT/SIGHUP it appends one
 * line naming the sender, then restores the default action and re-raises so
 * the child's own shutdown path is unaffected.
 *
 * The handler is async-signal-safe: the log fd is opened before any signal can
 * arrive, the number formatting is hand-rolled, and it uses write(2) only.
 * printf/malloc in a signal handler can deadlock, which would corrupt exactly
 * the capture we need.
 *
 * BUILD
 *     cc -O2 -Wall -o signal-canary signal-canary.c
 *
 * USE
 *     ./signal-canary /tmp/856-canary.log -- npx sequant run 123
 *
 * Then, when a run dies, /tmp/856-canary.log names the sender PID. Resolve it
 * immediately — `ps -p <pid> -o pid,ppid,pgid,command` — because the sender may
 * itself exit shortly after.
 */

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int log_fd = -1;
static pid_t child_pid = 0;

/* Async-signal-safe unsigned-to-decimal. Returns bytes written to buf. */
static int u2s(char *buf, unsigned long v) {
    char tmp[24];
    int n = 0, i;
    if (v == 0) { buf[0] = '0'; return 1; }
    while (v > 0 && n < (int)sizeof(tmp)) { tmp[n++] = (char)('0' + (v % 10)); v /= 10; }
    for (i = 0; i < n; i++) buf[i] = tmp[n - 1 - i];
    return n;
}

static void append(char *buf, int *len, const char *s) {
    while (*s) buf[(*len)++] = *s++;
}

/*
 * The whole point of the exercise: record si_pid — the sender — before we die.
 * Everything here must be async-signal-safe.
 */
static void on_signal(int sig, siginfo_t *info, void *ctx) {
    (void)ctx;
    char buf[256];
    int len = 0;
    struct timespec ts;

    append(buf, &len, "sig=");
    len += u2s(buf + len, (unsigned long)sig);
    append(buf, &len, " sender_pid=");
    /* info may be NULL if the signal arrived without SA_SIGINFO context. */
    len += u2s(buf + len, info ? (unsigned long)info->si_pid : 0UL);
    append(buf, &len, " sender_uid=");
    len += u2s(buf + len, info ? (unsigned long)info->si_uid : 0UL);
    append(buf, &len, " victim_pid=");
    len += u2s(buf + len, (unsigned long)getpid());
    append(buf, &len, " victim_pgid=");
    len += u2s(buf + len, (unsigned long)getpgrp());
    append(buf, &len, " child_pid=");
    len += u2s(buf + len, (unsigned long)child_pid);
    append(buf, &len, " mono_sec=");
    if (clock_gettime(CLOCK_MONOTONIC, &ts) == 0)
        len += u2s(buf + len, (unsigned long)ts.tv_sec);
    else
        append(buf, &len, "?");
    append(buf, &len, "\n");

    if (log_fd >= 0) {
        ssize_t w = write(log_fd, buf, (size_t)len);
        (void)w; /* nothing useful to do on failure inside a handler */
    }
    /* Also to stderr, so it lands in a captured task output too. */
    { ssize_t w = write(2, buf, (size_t)len); (void)w; }

    /* Pass the signal on: restore default and re-raise so the child's own
     * shutdown path behaves exactly as it would without the canary. */
    signal(sig, SIG_DFL);
    if (child_pid > 0) kill(child_pid, sig);
    raise(sig);
}

int main(int argc, char **argv) {
    int i, sep = -1;
    struct sigaction sa;
    int status = 0;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { sep = i; break; }
    }
    if (argc < 4 || sep < 2) {
        fprintf(stderr,
                "usage: %s <logfile> -- <command> [args...]\n"
                "  e.g. %s /tmp/856-canary.log -- npx sequant run 123\n",
                argv[0], argv[0]);
        return 2;
    }

    /* Open the log BEFORE any signal can arrive — opening inside a handler
     * would not be async-signal-safe, and a signal during startup is exactly
     * the window we cannot afford to miss. */
    log_fd = open(argv[1], O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (log_fd < 0) {
        fprintf(stderr, "canary: cannot open %s: %s\n", argv[1], strerror(errno));
        return 2;
    }

    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = on_signal;
    sa.sa_flags = SA_SIGINFO;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGTERM, &sa, NULL) != 0 ||
        sigaction(SIGINT,  &sa, NULL) != 0 ||
        sigaction(SIGHUP,  &sa, NULL) != 0) {
        fprintf(stderr, "canary: sigaction failed: %s\n", strerror(errno));
        return 2;
    }

    fprintf(stderr, "canary: armed pid=%d pgid=%d log=%s\n",
            (int)getpid(), (int)getpgrp(), argv[1]);
    fflush(stderr);

    child_pid = fork();
    if (child_pid < 0) {
        fprintf(stderr, "canary: fork failed: %s\n", strerror(errno));
        return 2;
    }
    if (child_pid == 0) {
        /* Child: default dispositions, same process group as the canary so a
         * group-directed signal reaches both. */
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        signal(SIGHUP, SIG_DFL);
        execvp(argv[sep + 1], &argv[sep + 1]);
        fprintf(stderr, "canary: exec %s failed: %s\n", argv[sep + 1], strerror(errno));
        _exit(127);
    }

    while (waitpid(child_pid, &status, 0) < 0 && errno == EINTR) { /* retry */ }

    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 0;
}
