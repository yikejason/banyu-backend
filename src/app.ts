import cors from "cors";
import express from "express";
import moodsRouter from "./routes/moods.js";

export function createApp() {
  const app = express();
  // 经过 Next rewrite 或反向代理时，从 X-Forwarded-For 取真实 IP（限频依赖）
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? false,
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", moodsRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ error: "服务器错误" });
  });
  return app;
}
