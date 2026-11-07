/* 홈 화면 추가(PWA)용 최소 서비스 워커. 화면은 모두 실시간 데이터이므로 캐시하지 않고 항상 네트워크로 간다(오프라인 화면 없음). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  /* 네트워크 그대로(가로채지 않음) */
});
