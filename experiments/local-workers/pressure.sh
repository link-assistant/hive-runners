#!/bin/sh
set -eu

test "$(id -u)" = 1000 || exit 11
test "$(cat /sys/fs/cgroup/cpu.max)" = '20000 100000' || exit 12
test "$(cat /sys/fs/cgroup/memory.max)" = 218103808 || exit 13
test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0 || exit 14
test "$(cat /sys/fs/cgroup/pids.max)" = 512 || exit 15
test ! -S /var/run/docker.sock || exit 16
if touch /writable-root; then exit 17; fi

yes >/dev/null &
child=$!
trap 'kill "$child" 2>/dev/null || true' EXIT
sleep 1
kill "$child"
wait "$child" || true
trap - EXIT

dd if=/dev/zero of=/hive/first bs=1M count=8 2>/dev/null || exit 18
if dd if=/dev/zero of=/hive/full bs=1M count=65 2>/dev/null; then exit 19; fi
if dd if=/dev/zero of=/tmp/full bs=1M count=17 2>/dev/null; then exit 20; fi
rm /tmp/full
before=$(cat /sys/fs/cgroup/memory.current)
sh -c 'dd if=/dev/zero of=/tmp/build-daemon-cache bs=1M count=8 2>/dev/null'
after=$(cat /sys/fs/cgroup/memory.current)
test "$after" -ge "$((before + 4194304))" && test "$after" -lt 218103808 || exit 21
