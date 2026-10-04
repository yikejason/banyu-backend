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

## 部署

`npm run build && npm start`。生产环境务必通过 HTTPS 反代并在 `CORS_ORIGIN` 里放行前端域名；`trust proxy` 已按一层代理设置。
