import { prisma } from "./prisma.js";

// 过期/核销的实时判断在请求路径上完成，这里只是数据保留策略：
// 过期超过 7 天的记录物理删除，心境正文与口令哈希随之销毁。
const RETENTION_MS = 7 * 24 * 3600_000;

export async function cleanupExpiredShares(): Promise<number> {
  const deleted = await prisma.anonymousMood.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - RETENTION_MS) } },
  });
  return deleted.count;
}
