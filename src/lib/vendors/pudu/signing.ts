import { createHash, createHmac } from "node:crypto";

/**
 * PUDU 개방 플랫폼 요청 서명 (공식 인증 가이드 "Application Credential" 의 알고리즘을 그대로 구현).
 *
 * 서명 문자열:
 *   x-date: {date}\n{METHOD}\n{Accept}\n{Content-Type}\n{Content-MD5}\n{signPath}
 * - date: RFC1123 GMT (예: Tue, 28 Oct 2026 10:00:00 GMT)
 * - Content-MD5: POST 일 때 body 의 md5 hex 문자열을 base64 한 값, GET 은 빈 문자열
 * - signPath: path + "?" + 정렬된 쿼리. 키 사전순, 배열은 쉼표 연결, 값이 없으면 키만. 값은 URL 디코딩 상태.
 *   /release, /test, /prepub 접두사는 서명 경로에서 제거.
 * - 서명: HMAC-SHA1(ApiAppSecret, signingStr) → base64
 * - Authorization: hmac id="<ApiAppKey>", algorithm="hmac-sha1", headers="x-date", signature="<base64>"
 */
export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export const ACCEPT = "application/json";
export const CONTENT_TYPE = "application/json";

export function contentMd5(bodyStr: string): string {
  if (!bodyStr) return "";
  const hex = createHash("md5").update(bodyStr, "utf8").digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

/** 실제 전송용 쿼리(인코딩됨)와 서명용 쿼리(디코딩됨)를 같은 정렬 규칙으로 만든다. */
export function buildQuery(params: Record<string, QueryValue>): { encoded: string; forSign: string } {
  const enc: string[] = [];
  const raw: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    // 값이 없는(undefined/null) 파라미터는 아예 보내지 않는다. 실기 확인: 키만 보내면("product_code") 서버가 빈 값 필터로 해석해 결과가 0건이 된다.
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const items = value.filter((v) => v !== null && v !== undefined && String(v) !== "").map(String);
      if (items.length === 0) {
        enc.push(key);
        raw.push(key);
      } else {
        enc.push(`${key}=${items.map(encodeURIComponent).join(",")}`);
        raw.push(`${key}=${items.join(",")}`);
      }
    } else if (value === null || value === undefined || String(value) === "") {
      enc.push(key);
      raw.push(key);
    } else {
      enc.push(`${key}=${encodeURIComponent(String(value))}`);
      raw.push(`${key}=${String(value)}`);
    }
  }
  return { encoded: enc.join("&"), forSign: raw.join("&") };
}

export function stripEnvPrefix(path: string): string {
  for (const p of ["/release", "/test", "/prepub"]) {
    if (path.startsWith(p)) {
      const rest = path.slice(p.length);
      return rest.startsWith("/") ? rest : `/${rest}`;
    }
  }
  return path || "/";
}

export function signingString(opts: { date: string; method: string; md5: string; path: string; queryForSign: string }): string {
  const signPath = opts.queryForSign ? `${stripEnvPrefix(opts.path)}?${opts.queryForSign}` : stripEnvPrefix(opts.path);
  return [`x-date: ${opts.date}`, opts.method.toUpperCase(), ACCEPT, CONTENT_TYPE, opts.md5, signPath].join("\n");
}

export function hmacSha1Base64(secret: string, message: string): string {
  return createHmac("sha1", secret).update(message, "utf8").digest("base64");
}

export function authorizationHeader(apiAppKey: string, signature: string): string {
  return `hmac id="${apiAppKey}", algorithm="hmac-sha1", headers="x-date", signature="${signature}"`;
}

export interface SignedRequest {
  path: string; // 전송 경로(쿼리 포함, 인코딩됨)
  headers: Record<string, string>;
  body: string;
}

/** 요청 서명 생성. 서버 검증과 동일한 규칙으로 서명 문자열을 만든다. */
export function signRequest(opts: {
  apiAppKey: string;
  apiAppSecret: string;
  method: "GET" | "POST";
  path: string; // 예: /pudu-entry/data-open-platform-service/v1/api/robot
  query?: Record<string, QueryValue>;
  body?: unknown;
  date?: string;
}): SignedRequest {
  const date = opts.date ?? new Date().toUTCString();
  const isGet = opts.method === "GET";
  const q = buildQuery(opts.query ?? {});
  const bodyStr = isGet ? "" : JSON.stringify(opts.body ?? {});
  const md5 = isGet ? "" : contentMd5(bodyStr);
  const str = signingString({ date, method: opts.method, md5, path: opts.path, queryForSign: isGet ? q.forSign : "" });
  const signature = hmacSha1Base64(opts.apiAppSecret, str);
  return {
    path: isGet && q.encoded ? `${opts.path}?${q.encoded}` : opts.path,
    headers: {
      Accept: ACCEPT,
      "Content-Type": CONTENT_TYPE,
      "Content-MD5": md5,
      "x-date": date,
      Authorization: authorizationHeader(opts.apiAppKey, signature),
    },
    body: bodyStr,
  };
}

/** 서버 측 검증(모의 서버·테스트용): 같은 규칙으로 재계산해 비교한다. */
export function verifySignature(opts: { apiAppSecret: string; method: string; pathWithQuery: string; date: string; md5: string; authorization: string }): boolean {
  const m = opts.authorization.match(/signature="([^"]+)"/);
  if (!m) return false;
  const [path, query = ""] = opts.pathWithQuery.split("?");
  const decodedQuery = query
    ? query
        .split("&")
        .map((kv) => {
          const [k, v] = kv.split("=");
          return v === undefined ? k : `${k}=${decodeURIComponent(v)}`;
        })
        .join("&")
    : "";
  const expected = hmacSha1Base64(opts.apiAppSecret, signingString({ date: opts.date, method: opts.method, md5: opts.md5, path, queryForSign: decodedQuery }));
  return expected === m[1];
}
