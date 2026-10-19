import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

// 匿名心情分享（方案 B）：链接 + 访问口令，无需注册登录。
//
// 项目没有账号体系，用客户端生成并持久化的设备标识 clientId 作为「账号」限制主体：
// - 创建冷却：同一 clientId 每 7 天最多成功创建 1 份（原子抢占配额，并发请求至多一个成功）；
// - 一次性核销：每份分享首次口令验证成功即核销，核销同时抹除正文与口令哈希，
//   之后任何人（即使口令正确）都只能得到「已被访问」，并发验证至多一个请求拿到正文；
// - 有效期：expiresAt 由服务端时间计算，过期实时拦截，与清理任务无关。

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
// 账号冷却与分享最长有效期都是 7 天
const COOLDOWN_MS = 7 * 24 * 3600_000;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const createSchema = z.object({
  clientId: z.string().regex(CLIENT_ID_RE, "客户端标识不合法"),
  content: z.string().trim().min(1, "心情内容不能为空").max(1000, "心情内容最多 1000 字"),
  passcode: z.string().regex(/^\d{4,6}$/, "口令须为 4-6 位数字"),
  expireHours: z.number().int().min(1, "有效期限不合法").max(168, "有效期限最多 7 天").default(24),
});

const verifySchema = z.object({
  shareCode: z.string().min(1, "缺少分享标识"),
  passcode: z.string().regex(/^\d{4,6}$/, "口令须为 4-6 位数字"),
});

// 单个 IP 每 5 分钟最多 20 次校验，防 4 位口令被遍历
const verifyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "尝试太频繁，请 5 分钟后再来" },
});

// 单个 IP 每小时最多 10 次创建：clientId 是客户端生成的，恶意轮换可绕过冷却，用 IP 限频兜底
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "创建太频繁，请 1 小时后再试" },
});

function cooldownReject(nextAllowedAt: number) {
  return {
    code: "COOLDOWN",
    error: "每个账号每 7 天仅可创建一次心境分享",
    nextAllowedAt: new Date(nextAllowedAt).toISOString(),
  };
}

const router = Router();

router.post("/moods/anonymous", createLimiter, async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "参数不合法" });
    return;
  }
  const { clientId, content, passcode, expireHours } = parsed.data;
  const now = new Date();
  const cutoff = new Date(now.getTime() - COOLDOWN_MS);

  // 幂等地确保配额行存在（epoch 表示从未创建过，首次即可用）。
  // 并发首建时唯一约束保证只有一方 insert 成功，败方继续走事务内的条件更新。
  try {
    await prisma.moodCreator.create({ data: { clientId, lastCreatedAt: new Date(0) } });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }

  // 配额抢占与分享创建在同一事务里提交：要么都成功，要么都不留痕，
  // 网络重试/重复点击也不可能产生第二份记录（结构上的幂等）。
  const result = await prisma.$transaction(async (tx) => {
    // 原子抢占 7 天配额：条件更新仅在冷却已结束时生效。
    // Postgres 行锁下，同一 clientId 的并发请求串行执行，后到者的条件必然失败。
    const claimed = await tx.moodCreator.updateMany({
      where: { clientId, lastCreatedAt: { lte: cutoff } },
      data: { lastCreatedAt: now },
    });
    if (claimed.count === 0) {
      const row = await tx.moodCreator.findUniqueOrThrow({ where: { clientId } });
      return { ok: false as const, nextAllowedAt: row.lastCreatedAt.getTime() + COOLDOWN_MS };
    }
    const share = await tx.anonymousMood.create({
      data: {
        shareCode: `m_${nanoid(8)}`,
        content,
        // bcrypt 计算成本足以抵消 4-6 位数字口令的离线暴力破解
        passcodeHash: await bcrypt.hash(passcode, 10),
        expiresAt: new Date(now.getTime() + expireHours * 3600_000),
      },
    });
    return { ok: true as const, share };
  });

  if (!result.ok) {
    res.status(429).json(cooldownReject(result.nextAllowedAt));
    return;
  }
  res.status(201).json({
    shareCode: result.share.shareCode,
    expiresAt: result.share.expiresAt.toISOString(),
    nextAllowedAt: new Date(now.getTime() + COOLDOWN_MS).toISOString(),
  });
});

// 当前设备的创建配额，仅供前端展示冷却状态；真正的拦截在创建接口里
router.get("/moods/quota", async (req, res) => {
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
  if (!CLIENT_ID_RE.test(clientId)) {
    res.status(400).json({ error: "客户端标识不合法" });
    return;
  }
  const row = await prisma.moodCreator.findUnique({ where: { clientId } });
  const nextAllowedAt = (row?.lastCreatedAt.getTime() ?? 0) + COOLDOWN_MS;
  res.json({
    nextAllowedAt: nextAllowedAt > Date.now() ? new Date(nextAllowedAt).toISOString() : null,
  });
});

router.post("/moods/verify", verifyLimiter, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "参数不合法" });
    return;
  }
  const { shareCode, passcode } = parsed.data;

  const mood = await prisma.anonymousMood.findUnique({ where: { shareCode } });
  if (!mood) {
    res.status(404).json({ code: "NOT_FOUND", error: "心情分享不存在或已失效" });
    return;
  }
  if (mood.expiresAt.getTime() <= Date.now()) {
    res.status(410).json({ code: "EXPIRED", error: "该分享已超出有效时间" });
    return;
  }
  if (mood.redeemedAt) {
    res.status(409).json({ code: "REDEEMED", error: "该分享已被访问，无法再次查看" });
    return;
  }
  if (mood.lockedUntil && mood.lockedUntil.getTime() > Date.now()) {
    const remainingMins = Math.ceil((mood.lockedUntil.getTime() - Date.now()) / 60000);
    res.status(429).json({ code: "LOCKED", error: `口令错误次数过多，请 ${remainingMins} 分钟后再试` });
    return;
  }

  const ok = await bcrypt.compare(passcode, mood.passcodeHash);
  if (!ok) {
    // 错误口令只累计失败次数，不消耗一次性核销资格
    const attempts = mood.failedAttempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    await prisma.anonymousMood.update({
      where: { id: mood.id },
      data: lock
        ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
        : { failedAttempts: attempts },
    });
    res.status(401).json({
      code: "WRONG_PASSCODE",
      error: lock
        ? `错误次数过多，已锁定 ${LOCK_MINUTES} 分钟`
        : `口令错误，还可尝试 ${MAX_ATTEMPTS - attempts} 次`,
    });
    return;
  }

  // 核销竞态：条件更新（未被核销且未过期才生效）是唯一的入场券。
  // 并发请求中最多一个 count=1，其余落入 409。核销同时抹除正文与口令验证材料。
  const claimed = await prisma.anonymousMood.updateMany({
    where: { id: mood.id, redeemedAt: null, expiresAt: { gt: new Date() } },
    data: { redeemedAt: new Date(), content: "", passcodeHash: "", failedAttempts: 0, lockedUntil: null },
  });
  if (claimed.count === 0) {
    res.status(409).json({ code: "REDEEMED", error: "该分享已被访问，无法再次查看" });
    return;
  }
  // 只有拿到核销资格的请求才返回正文；正文来自核销前读出的内存副本
  res.json({ content: mood.content, createdAt: mood.createdAt.toISOString() });
});

export default router;
