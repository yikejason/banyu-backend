#!/usr/bin/env bash
# banyu-backend 部署脚本
#
# 做什么:本地构建 linux/amd64 镜像 → 流式直传服务器 docker load → 原地替换容器 → 偍康检查
# 前提:~/.ssh/config 里已配好 banyu 别名;服务器 /root/banyu-backend 已有 .env 和 docker-compose.yml
# 用法:./scripts/deploy.sh        (首次部署不用本脚本,见 README)
#      SERVER=其他别名 ./scripts/deploy.sh
set -euo pipefail

SERVER_ALIAS="${SERVER:-banyu}"
REMOTE_DIR="${REMOTE_DIR:-/root/banyu-backend}"
IMAGE="banyu-backend-app:latest"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

log "构建 linux/amd64 镜像(本机是 Apple Silicon 也不会踩架构坑)"
docker build --platform linux/amd64 -t "$IMAGE" .

log "流式传输镜像到 ${SERVER_ALIAS} 并替换容器(服务中断仅数秒)"
docker save "$IMAGE" | gzip \
  | ssh "$SERVER_ALIAS" "gunzip -c | docker load >/dev/null && cd ${REMOTE_DIR} && docker compose up -d"

log "健康检查(预期 404 = 应用与数据库都活着)"
sleep 5
code=$(ssh "$SERVER_ALIAS" "curl -s -o /dev/null -w '%{http_code}' -m 8 -X POST http://127.0.0.1:8787/api/moods/verify -H 'Content-Type: application/json' -d '{\"shareCode\":\"m_deploy_check\",\"passcode\":\"0000\"}'")
if [ "$code" = "404" ]; then
  log "部署成功 ✅  入口 http://47.109.47.66 ,API 走 /api/*(nginx 同源反代)"
else
  echo "!! 健康检查异常(HTTP $code,预期 404),最近日志:" >&2
  ssh "$SERVER_ALIAS" "cd ${REMOTE_DIR} && docker compose logs --tail 30 app" >&2
  exit 1
fi
