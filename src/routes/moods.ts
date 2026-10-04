import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

// 匿名心情分享（方案 B）：链接 + 访问口令，无需注册登录。

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const createSchema = z.object({
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

const router = Router();

router.post("/moods/anonymous", async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "参数不合法" });
    return;
  }
  const { content, passcode, expireHours } = parsed.data;
  const passcodeHash = await bcrypt.hash(passcode, 10);
  const shareCode = `m_${nanoid(8)}`;
  const expiresAt = new Date(Date.now() + expireHours * 3600_000);
  await prisma.anonymousMood.create({ data: { shareCode, content, passcodeHash, expiresAt } });
  res.status(201).json({ shareCode });
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
    res.status(404).json({ error: "心情分享不存在或已失效" });
    return;
  }
  if (mood.expiresAt.getTime() <= Date.now()) {
    res.status(410).json({ error: "该分享已超出有效时间" });
    return;
  }
  if (mood.lockedUntil && mood.lockedUntil.getTime() > Date.now()) {
    const remainingMins = Math.ceil((mood.lockedUntil.getTime() - Date.now()) / 60000);
    res.status(429).json({ error: `口令错误次数过多，请 ${remainingMins} 分钟后再试` });
    return;
  }

  const ok = await bcrypt.compare(passcode, mood.passcodeHash);
  if (!ok) {
    const attempts = mood.failedAttempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    await prisma.anonymousMood.update({
      where: { id: mood.id },
      data: lock
        ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
        : { failedAttempts: attempts },
    });
    res.status(401).json({
      error: lock
        ? `错误次数过多，已锁定 ${LOCK_MINUTES} 分钟`
        : `口令错误，还可尝试 ${MAX_ATTEMPTS - attempts} 次`,
    });
    return;
  }

  await prisma.anonymousMood.update({
    where: { id: mood.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  res.json({ content: mood.content, createdAt: mood.createdAt.toISOString() });
});

export default router;
