import { createApp } from "./app.js";
import { cleanupExpiredShares } from "./lib/cleanup.js";

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件时直接使用进程环境变量
}

const port = Number(process.env.PORT ?? 8787);
createApp().listen(port, () => {
  console.log(`banyu-backend listening on http://localhost:${port}`);
});

// 每日清理过期分享；失败只记日志，不影响服务，下次再试
async function runCleanup() {
  try {
    const count = await cleanupExpiredShares();
    if (count > 0) console.log(`[cleanup] 已清理过期分享 ${count} 条`);
  } catch (err) {
    console.error("[cleanup] 清理过期分享失败", err);
  }
}

void runCleanup();
setInterval(runCleanup, 24 * 3600_000).unref();
