#!/bin/sh
set -eu
umask 077
cd /hive
ticket=${HIVE_WORKER_TICKET-}
unset HIVE_WORKER_TICKET
if [ -z "$ticket" ]; then
  ticket=$(cat /run/secrets/hive-ticket)
fi
export HOME=/hive

# GitHub and GitLab stream job logs directly to their CI services.
exec >/dev/null 2>&1
case "$HIVE_PROVIDER" in
  github)
    mkdir /hive/runner
    cp -a /home/runner/. /hive/runner/
    cd /hive/runner
    exec ./run.sh --jitconfig "$ticket"
    ;;
  gitlab)
    exec gitlab-runner run-single --url "$HIVE_PROJECT_ORIGIN" --token "$ticket" \
      --executor shell --builds-dir /hive/builds --cache-dir /hive/cache \
      --max-builds 1 --wait-timeout 60
    ;;
  *)
    exit 64
    ;;
esac
