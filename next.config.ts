import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 시제품은 모든 화면이 요청마다 바뀌는 동적 데이터(메모리 저장소 + 역할 쿠키)를 사용하므로
  // Cache Components 모델을 끄고 기존 동적 렌더링 모델을 사용한다.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
