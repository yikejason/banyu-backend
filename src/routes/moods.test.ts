// 集成测试：走真实 HTTP + 真实 Postgres，覆盖正常/异常/并发场景。
// 运行前需要本地数据库：docker compose up -d db && npm run db:push
import bcrypt from "bcryptjs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../app.js";
import { cleanupExpiredShares } from "../lib/cleanup.js";
import { prisma } from "../lib/prisma.js";

try {
  process.loadEnvFile();
} catch {
  // 无 .env 时直接用进程环境变量
}

const RUN = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const PASSCODE = "1234";

let server: Server;
let base: string;
let hash: string;
let seq = 0;
// app 开了 trust proxy，测试里每个请求带独立 X-Forwarded-For，绕开限流桶（限流逻辑不在本套件范围）
let ipSeq = 0;
const apiShareCodes: string[] = [];

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.18.0.${++ipSeq % 250}` },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(`${base}${path}`, {
    headers: { "x-forwarded-for": `198.18.0.${++ipSeq % 250}` },
  });
}

async function seedShare(over: Record<string, unknown> = {}) {
  return prisma.anonymousMood.create({
    data: {
      shareCode: `test_${RUN}_${++seq}`,
      content: "测试心境正文",
      passcodeHash: hash,
      expiresAt: new Date(Date.now() + 3600_000),
      ...over,
    },
  });
}

beforeAll(async () => {
  hash = await bcrypt.hash(PASSCODE, 10);
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await prisma.anonymousMood.deleteMany({
    where: { OR: [{ shareCode: { startsWith: `test_${RUN}` } }, { shareCode: { in: apiShareCodes } }] },
  });
  await prisma.moodCreator.deleteMany({ where: { clientId: { startsWith: `test_${RUN}` } } });
  await prisma.$disconnect();
  server.close();
});

test("新设备创建成功，返回 shareCode / 有效期 / 下次可创建时间", async () => {
  const clientId = `test_${RUN}_a`;
  const res = await post("/api/moods/anonymous", {
    clientId,
    content: "今晚月色真好",
    passcode: "0123",
    expireHours: 24,
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { shareCode: string; expiresAt: string; nextAllowedAt: string };
  apiShareCodes.push(data.shareCode);
  expect(data.shareCode).toMatch(/^m_[A-Za-z0-9_-]+$/);
  expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  expect(new Date(data.nextAllowedAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
});

test("同设备 7 天内再创建被拒，返回 COOLDOWN 与剩余冷却信息", async () => {
  const res = await post("/api/moods/anonymous", {
    clientId: `test_${RUN}_a`,
    content: "再写一条",
    passcode: "1234",
    expireHours: 1,
  });
  expect(res.status).toBe(429);
  const data = (await res.json()) as { code: string; error: string; nextAllowedAt: string };
  expect(data.code).toBe("COOLDOWN");
  expect(new Date(data.nextAllowedAt).getTime()).toBeGreaterThan(Date.now());
});

test("换设备（不同 clientId）不受其他设备冷却影响", async () => {
  const res = await post("/api/moods/anonymous", {
    clientId: `test_${RUN}_b`,
    content: "另一台设备",
    passcode: "5678",
    expireHours: 1,
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { shareCode: string };
  apiShareCodes.push(data.shareCode);
});

test("同设备并发创建 5 个请求，恰好 1 个成功", async () => {
  const clientId = `test_${RUN}_race`;
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      post("/api/moods/anonymous", { clientId, content: "并发", passcode: "1111", expireHours: 1 }),
    ),
  );
  const statuses = results.map((r) => r.status).sort();
  expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  const created = await results.find((r) => r.status === 201)!.json();
  apiShareCodes.push((created as { shareCode: string }).shareCode);
});

test("缺少 clientId 的旧客户端请求被拒绝（400）", async () => {
  const res = await post("/api/moods/anonymous", {
    content: "旧客户端没有 clientId",
    passcode: "1234",
    expireHours: 1,
  });
  expect(res.status).toBe(400);
});

test("quota 查询：新设备为 null，已创建设备返回下次可创建时间", async () => {
  const fresh = await get(`/api/moods/quota?clientId=test_${RUN}_fresh0000`);
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toEqual({ nextAllowedAt: null });

  const cooling = await get(`/api/moods/quota?clientId=test_${RUN}_a`);
  const data = (await cooling.json()) as { nextAllowedAt: string };
  expect(new Date(data.nextAllowedAt).getTime()).toBeGreaterThan(Date.now());
});

test("正确口令首次验证返回正文，再验证（同口令）得到 409 REDEEMED", async () => {
  const share = await seedShare();
  const ok = await post("/api/moods/verify", { shareCode: share.shareCode, passcode: PASSCODE });
  expect(ok.status).toBe(200);
  const data = (await ok.json()) as { content: string; createdAt: string };
  expect(data.content).toBe("测试心境正文");

  const again = await post("/api/moods/verify", { shareCode: share.shareCode, passcode: PASSCODE });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { code: string }).code).toBe("REDEEMED");
});

test("核销后数据库中的正文与口令哈希被抹除", async () => {
  const share = await seedShare();
  await post("/api/moods/verify", { shareCode: share.shareCode, passcode: PASSCODE });
  const row = await prisma.anonymousMood.findUniqueOrThrow({ where: { id: share.id } });
  expect(row.content).toBe("");
  expect(row.passcodeHash).toBe("");
  expect(row.redeemedAt).not.toBeNull();
});

test("并发 5 个正确口令验证同一分享，恰好 1 个拿到正文", async () => {
  const share = await seedShare();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      post("/api/moods/verify", { shareCode: share.shareCode, passcode: PASSCODE }),
    ),
  );
  const okCount = results.filter((r) => r.status === 200).length;
  const conflictCount = results.filter((r) => r.status === 409).length;
  expect(okCount).toBe(1);
  expect(conflictCount).toBe(4);
});

test("错误口令返回 401 且不消耗一次性核销资格", async () => {
  const share = await seedShare();
  const wrong = await post("/api/moods/verify", { shareCode: share.shareCode, passcode: "9999" });
  expect(wrong.status).toBe(401);

  const ok = await post("/api/moods/verify", { shareCode: share.shareCode, passcode: PASSCODE });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { content: string }).content).toBe("测试心境正文");
});

test("过期分享返回 410，不存在的分享返回 404", async () => {
  const expired = await seedShare({ expiresAt: new Date(Date.now() - 1000) });
  const res = await post("/api/moods/verify", { shareCode: expired.shareCode, passcode: PASSCODE });
  expect(res.status).toBe(410);
  expect(((await res.json()) as { code: string }).code).toBe("EXPIRED");

  const missing = await post("/api/moods/verify", { shareCode: "test_not_exist_zzz", passcode: PASSCODE });
  expect(missing.status).toBe(404);
});

test("清理任务删除过期超过 7 天的记录", async () => {
  await seedShare({ expiresAt: new Date(Date.now() - 8 * 24 * 3600_000) });
  const count = await cleanupExpiredShares();
  expect(count).toBeGreaterThan(0);
  const leftover = await prisma.anonymousMood.findMany({
    where: { shareCode: { startsWith: `test_${RUN}` }, expiresAt: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } },
  });
  expect(leftover).toHaveLength(0);
});
