# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    LRG_HOST=0.0.0.0 \
    LRG_PORT=8080 \
    LRG_RECORDS_DIR=/data/records \
    LRG_LOG_PATH=/data/gateway.log

COPY package.json server.mjs ./
COPY config.json.example ./config.json
COPY lib ./lib
COPY bin ./bin

# 以非 root 运行；/data 存放记录与日志
RUN mkdir -p /data/records && chown -R node:node /app /data
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/__gateway/status >/dev/null || exit 1

CMD ["node", "server.mjs"]
