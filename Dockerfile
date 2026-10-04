# ---- 构建阶段：安装依赖、生成 Prisma Client、编译 TS ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

# ---- 运行阶段：只装生产依赖 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# 构建阶段生成的 Prisma Client（含 Alpine 对应的查询引擎）
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 8787
# 启动前先同步表结构（幂等；本项目用 db push，无迁移文件）
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
