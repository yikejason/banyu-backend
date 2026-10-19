# banyu-backend

伴语星球的独立后端：Express 5 + Prisma + PostgreSQL。

## 接口

| 端点 | 说明 |
| --- | --- |
| `POST /api/moods/anonymous` | 匿名心情：`{clientId, content(≤1000字), passcode(4-6位数字), expireHours(1-168,默认24)}` → `201 {shareCode, expiresAt, nextAllowedAt}`；`429 {code:"COOLDOWN", nextAllowedAt}` 设备冷却中；`400` 参数不合法（含缺少 clientId 的旧客户端） |
| `GET /api/moods/quota?clientId=` | 查询设备配额 → `200 {nextAllowedAt: string\|null}`（仅前端展示用，拦截在创建接口） |
| `POST /api/moods/verify` | 口令校验：`{shareCode, passcode}` → `200 {content, createdAt}`（首次成功即核销，正文与口令哈希随即抹除）；`404` 不存在、`410` 过期、`409` 已被访问、`429` 锁定/限频、`401` 口令错（连错 5 次锁 15 分钟） |

安全规则（全部由后端原子强制，与前端状态无关）：

- **设备级创建冷却**：项目无账号体系，`clientId` 是前端持久化的设备标识。同一 `clientId` 每 7 天最多成功创建 1 份；配额用条件更新原子抢占，并发请求至多一个成功；配额与分享创建同事务提交，失败不留痕（结构上幂等，重试不会产生第二份）。
- **一次性核销**：口令验证通过后，用条件更新（`redeemedAt IS NULL` 且未过期）竞争核销资格，并发至多一个请求拿到正文；核销同时抹除 `content` 与 `passcodeHash`。错误口令只累计失败次数，不消耗核销资格。
- **有效期**：`expiresAt` 由服务端时间计算，验证时实时判断，与清理任务无关；过期记录保留 7 天后由每日清理任务物理删除。
- **限流**：`/verify` 单 IP 每 5 分钟 20 次；`/anonymous` 单 IP 每小时 10 次（兜底防 clientId 轮换刷冷却）。
- 口令哈希用 bcrypt（cost 10），抵消 4-6 位数字口令的离线暴力破解。

## 测试

集成测试走真实 HTTP + 真实 Postgres，覆盖冷却、一次性核销、过期与并发竞争：

```bash
docker compose up -d db && npm run db:push   # 或指向任意可用库
npm test
```

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
