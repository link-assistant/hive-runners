FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ansible-core ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /var/lib/hive /etc/hive
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node bin/ bin/
COPY --chown=node:node src/ src/
ENV HOST=0.0.0.0 PORT=8080 HIVE_STATE=/var/lib/hive/runner.sqlite HOME=/tmp
USER node
EXPOSE 8080
ENTRYPOINT ["node", "bin/hive-runners.js"]
CMD ["serve", "--config", "/etc/hive/config.json"]
