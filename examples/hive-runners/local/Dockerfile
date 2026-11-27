ARG RUNNER_IMAGE
FROM ${RUNNER_IMAGE}
COPY --chmod=0555 examples/hive-runners/local/worker.sh /opt/hive-worker
USER 1000:1000
