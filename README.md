# banyu-backend

伴语星球的独立后端：Express 5 + Prisma + PostgreSQL。

## 接口

| 端点 | 说明 |
| --- | --- |
| `POST /api/moods/anonymous` | 匿名心情：`{content(≤1000字), passcode(4-6位数字), expireHours(1-168,默认24)}` → `201 {shareCode}` |
| `POST /api/moods/verify` | 口令校验：`{shareCode, passcode}` → `200 {content, createdAt}`；`404` 不存在、`410` 过期、`429` 锁定/限频、`401` 口令错（连错 5 次锁 15 分钟） |

`/api/moods/verify` 另有单 IP 每 5 分钟 20 次的限频。

## 启动

```bash
cp .env.example .env   # 填 DATABASE_URL
docker compose up -d   # 没有现成 Postgres 时
npm install
npm run db:push        # 建表
npm run dev            # http://localhost:8787
```

banyu-web 侧在 `.env.local` 配 `API_BASE=http://localhost:8787`，其 next.config.ts 会把 `/api/*` 代理过来。

## 部署到服务器（Docker Compose）

服务器上装好 [Docker](https://docs.docker.com/engine/install/) 后，四条命令即可部署：

```bash
git clone https://github.com/yikejason/banyu-backend.git
cd banyu-backend
cp .env.example .env && vim .env   # 改 POSTGRES_PASSWORD 为强密码；CORS_ORIGIN 放行前端地址
docker compose up -d --build
```

- 生产入口 `https://ban-yu.xyz`（nginx 80/443 统一入口：静态前端 + `/api/*` 反代到 `127.0.0.1:8787`，证书由 certbot 自动签发续期，HTTP 自动跳转 HTTPS）
- 容器启动时会自动执行 `prisma db push` 同步表结构，数据存在 `banyu_pgdata` 卷里
- 数据库只监听容器网络，宿主机也仅绑定 `127.0.0.1:5432`，不对公网暴露

常用运维命令（在服务器 `/root/banyu-backend` 下）：

```bash
docker compose logs -f app                        # 看日志
docker compose exec db psql -U banyu -d banyu     # 进数据库
```

**更新后端**：在本地跑 `./scripts/deploy.sh`——构建 amd64 镜像、流式传到服务器 `docker load`、替换容器并做健康检查，一条命令完成。服务器上没有代码仓库，不要在服务器上构建。

域名 ban-yu.xyz 已上线（DNS 托管在 Vercel，A 记录指向服务器；nginx + certbot 负责 HTTPS）。`trust proxy` 已按一层代理设置；若前端独立部署到其他域名，把该域名放进 `CORS_ORIGIN` 即可。
