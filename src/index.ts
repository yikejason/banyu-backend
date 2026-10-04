import { createApp } from "./app.js";

try {
  process.loadEnvFile();
} catch {
  // 没有 .env 文件时直接使用进程环境变量
}

const port = Number(process.env.PORT ?? 8787);
createApp().listen(port, () => {
  console.log(`banyu-backend listening on http://localhost:${port}`);
});
