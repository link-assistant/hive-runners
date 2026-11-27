ARG RUNNER_IMAGE
FROM ${RUNNER_IMAGE}
USER 0:0
RUN mkdir -p /root && chmod 0700 /root
COPY --chmod=0555 examples/hive-runners/local/worker.sh /opt/hive-worker
USER 1000:1000
