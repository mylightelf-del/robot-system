# 청소로봇 통합관제 — 웹(standalone)과 워커를 한 이미지의 두 타깃으로 만든다.
# 빌드: docker compose build   /  수동: docker build --target web -t robot-web . && docker build --target worker -t robot-worker .

# ---- 공통 의존성 ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 빌드 ----
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# public/ 이 비어 있으면 git archive 번들에 빠지므로 항상 만들어 둔다(아래 COPY 가 실패하지 않도록)
RUN mkdir -p /app/public && npm run build

# ---- 웹 서버 (Next.js standalone 최소 런타임) ----
FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# 마이그레이션은 compose 의 migrate 서비스(워커 이미지)가 먼저 적용한다.
CMD ["node", "server.js"]

# ---- 워커 (tsx 로 TypeScript 직접 실행) ----
FROM deps AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
CMD ["npx", "tsx", "src/worker/main.ts"]
