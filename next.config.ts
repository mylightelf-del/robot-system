import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 시제품은 모든 화면이 요청마다 바뀌는 동적 데이터(메모리 저장소 + 역할 쿠키)를 사용하므로
  // Cache Components 모델을 끄고 기존 동적 렌더링 모델을 사용한다.
  cacheComponents: false,
  // Docker 이미지용 최소 런타임 출력
  output: "standalone",
  // 보안 헤더(Caddy 가 HTTPS 단에서 다시 붙이지만, 로컬·내부 접근에서도 같은 정책을 갖도록 앱에서도 설정)
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
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
