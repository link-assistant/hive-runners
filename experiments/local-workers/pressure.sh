#!/bin/sh
set -eu

test "$(id -u)" = 1000 || exit 11
test "$(cat /sys/fs/cgroup/cpu.max)" = '20000 100000' || exit 12
test "$(cat /sys/fs/cgroup/memory.max)" = 218103808 || exit 13
if test -r /run/secrets/hive-ticket; then
  test "$(cat /run/secrets/hive-ticket)" = fixture-ticket || exit 23
  test "$(wc -l </proc/swaps)" -eq 1 || exit 14
  temporary_mib=9
else
  test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0 || exit 14
  test "$(cat /sys/fs/cgroup/pids.max)" = 512 || exit 15
  temporary_mib=17
fi
test ! -S /var/run/docker.sock || exit 16
awk '$2 == "/" && $4 ~ /(^|,)ro(,|$)/ { locked = 1 } END { exit !locked }' /proc/mounts || exit 17

cpu_before=$(awk '$1 == "usage_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
yes >/dev/null &
child=$!
trap 'kill "$child" 2>/dev/null || true' EXIT
sleep 1
kill "$child"
wait "$child" || true
trap - EXIT
cpu_after=$(awk '$1 == "usage_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
test "$cpu_after" -gt "$cpu_before" || exit 22

dd if=/dev/zero of=/hive/first bs=1M count=8 2>/dev/null || exit 18
if dd if=/dev/zero of=/hive/full bs=1M count=65 2>/dev/null; then exit 19; fi
if dd if=/dev/zero of=/tmp/full bs=1M count="$temporary_mib" 2>/dev/null; then exit 20; fi
rm /tmp/full
before=$(cat /sys/fs/cgroup/memory.current)
sh -c 'dd if=/dev/zero of=/tmp/build-daemon-cache bs=1M count=8 2>/dev/null'
after=$(cat /sys/fs/cgroup/memory.current)
test "$after" -ge "$((before + 4194304))" && test "$after" -lt 218103808 || exit 21
