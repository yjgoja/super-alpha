/**
 * Live-trading engine safety: refuse serverless Neon, validate DB, classify fatal errors.
 * Neon Free quota kills the engine while positions stay open — never allow that path.
 */

const BLOCKED_DB_HOST_RE =
  /(^|\.)neon\.(tech|db)(:|$)|neon\.tech|neon\.db|aws\.neon\.tech/i;

export function parseDatabaseHost(url = process.env.DATABASE_URL || ""): string | null {
  if (!url.trim()) return null;
  try {
    const u = new URL(url.replace(/^postgresql:/i, "http:").replace(/^postgres:/i, "http:"));
    return u.hostname || null;
  } catch {
    const m = url.match(/@([^/?]+)/);
    return m?.[1]?.split(":")[0] || null;
  }
}

export function assertTradingDatabase(env: NodeJS.ProcessEnv = process.env): {
  host: string;
} {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("[engine-guard] DATABASE_URL 없음 — 엔진을 시작할 수 없습니다.");
  }
  const host = parseDatabaseHost(url);
  if (!host) {
    throw new Error("[engine-guard] DATABASE_URL 호스트 파싱 실패");
  }

  const allowNeon = env.ALLOW_LEGACY_NEON === "1";
  if (!allowNeon && BLOCKED_DB_HOST_RE.test(host)) {
    throw new Error(
      `[engine-guard] Neon DB 차단: ${host}\n` +
        "서버리스 Neon 쿼터 초과 시 실계좌 익절/물타기/손절이 멈춥니다.\n" +
        "Render 등 always-on Postgres의 DATABASE_URL로 교체하세요.\n" +
        "(응급 시에만 ALLOW_LEGACY_NEON=1)",
    );
  }

  const allowSub = env.ENGINE_DB_HOST_ALLOW?.trim();
  if (allowSub && !host.toLowerCase().includes(allowSub.toLowerCase())) {
    throw new Error(
      `[engine-guard] DB 호스트 불일치: 현재=${host}, 허용 포함=${allowSub}\n` +
        ".env 의 DATABASE_URL / ENGINE_DB_HOST_ALLOW 를 확인하세요.",
    );
  }

  if (!env.METAAPI_TOKEN?.trim()) {
    throw new Error("[engine-guard] METAAPI_TOKEN 없음");
  }

  return { host };
}

/** Errors that mean trading must stop until env/infra is fixed (exit + supervisor restart). */
export function isFatalEngineError(err: unknown): boolean {
  const msg = String(
    err instanceof Error ? `${err.name} ${err.message}` : err ?? "",
  ).toLowerCase();

  const needles = [
    "exceeded the compute time quota",
    "compute time quota",
    "neon",
    "can't reach database server",
    "cannot reach database server",
    "password authentication failed",
    "authentication failed against database",
    "too many connections",
    "remaining connection slots",
    "connection terminated",
    "server closed the connection",
    "econnrefused",
    "enotfound",
    "etimedout",
    "p1001",
    "p1002",
    "p1003",
    "p1008",
    "p1017",
    "engine-guard",
    "database_url",
  ];
  return needles.some((n) => msg.includes(n));
}

export function isCloudColdError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("클라우드") ||
    m.includes("cloud") ||
    m.includes("not connected") ||
    m.includes("undeploy") ||
    m.includes("deploy") ||
    m.includes("계좌 정보를 가져오지")
  );
}
