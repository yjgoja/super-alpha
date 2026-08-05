/**
 * Render engine deploy + env sync (fail-closed, no trading side effects).
 *
 * Requires:
 *   RENDER_API_KEY          — Account API key (dashboard → Account Settings)
 * Optional:
 *   RENDER_SERVICE_ID       — srv-... (else discover by name)
 *   RENDER_SERVICE_NAME     — default super-alpha-engine
 *   RENDER_DEPLOY_HOOK_URL  — fallback trigger if API deploy fails
 *   RENDER_COMMIT           — commit SHA to deploy (default: current git HEAD / GITHUB_SHA)
 *
 * Run:
 *   npx tsx --env-file=.env scripts/render-deploy.ts
 *   npx tsx scripts/render-deploy.ts --sync-env --wait
 */
const API = "https://api.render.com/v1";

type Json = Record<string, unknown>;

const SERVICE_NAME =
  (process.env.RENDER_SERVICE_NAME || "super-alpha-engine").trim();

/** Env keys we must keep in sync with render.yaml / Dockerfile.engine for this release. */
const REQUIRED_ENV: Record<string, string> = {
  ENGINE_MODE: "direct",
  METAAPI_STREAM: "1",
  METAAPI_PRICE_REST: "0",
  METAAPI_PRICE_STREAM_WAIT_MS: "12000",
  ENGINE_CONCURRENCY: "4",
  METAAPI_REGION: "london",
  STREAM_OPEN_BASKETS: "1",
  STREAM_OPEN_INTERVAL_MS: "12000",
  STREAM_OPEN_MAX: "20",
  STREAM_OPEN_CONCURRENCY: "2",
  ENGINE_SNAP_STALE_MS: "15000",
  METAAPI_SNAP_MIN_MS: "10000",
  METAAPI_ACCOUNT_INFO_TTL_MS: "90000",
  METAAPI_PRICE_CACHE_MS: "5000",
  PNL_SYNC_THROTTLE_MS: "180000",
  IDLE_BOT_UNDEPLOY_HOURS: "2",
  BROKER_PROTECT_TP_SL: "1",
  ENGINE_BUDGET_MS: "600000",
  ENGINE_DB_HOST_ALLOW: "render.com",
  ENGINE_CLOUD_WAIT_MS: "45000",
  ENGINE_INTERVAL_MS: "60000",
  NODE_ENV: "production",
};

function argFlag(name: string) {
  return process.argv.includes(name);
}

function die(msg: string, code = 1): never {
  console.error(`[render-deploy] ${msg}`);
  process.exit(code);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const key = (process.env.RENDER_API_KEY || "").trim();
  if (!key) die("RENDER_API_KEY missing — add GitHub/Cursor secret once");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function resolveServiceId(): Promise<string> {
  const fixed = (process.env.RENDER_SERVICE_ID || "").trim();
  if (fixed) return fixed;

  const { status, data } = await api(
    "GET",
    `/services?name=${encodeURIComponent(SERVICE_NAME)}&limit=20`,
  );
  if (status >= 400) {
    die(`list services failed HTTP ${status}: ${JSON.stringify(data)}`);
  }
  const rows = Array.isArray(data) ? data : [];
  for (const row of rows) {
    const svc = (row as { service?: Json })?.service || (row as Json);
    const name = String(svc?.name || "");
    const id = String(svc?.id || "");
    if (name === SERVICE_NAME && id) return id;
  }
  // Fallback: list all and match
  const all = await api("GET", "/services?limit=50");
  const allRows = Array.isArray(all.data) ? all.data : [];
  for (const row of allRows) {
    const svc = (row as { service?: Json })?.service || (row as Json);
    const name = String(svc?.name || "");
    const id = String(svc?.id || "");
    if (name === SERVICE_NAME && id) return id;
  }
  die(
    `service "${SERVICE_NAME}" not found — set RENDER_SERVICE_ID=srv-... or create Blueprint`,
  );
}

async function disableAutoDeploy(serviceId: string) {
  // Prevent every master push from recycling the worker (exit emails).
  const { status, data } = await api("PATCH", `/services/${serviceId}`, {
    autoDeploy: "no",
  });
  if (status >= 400) {
    console.warn(
      `[render-deploy] autoDeploy=no PATCH HTTP ${status}: ${JSON.stringify(data).slice(0, 240)}`,
    );
    return;
  }
  console.log(`[render-deploy] autoDeploy=no ok`);
}

async function syncEnv(serviceId: string) {
  await disableAutoDeploy(serviceId);
  // NEVER bulk-replace env-vars — that deletes DATABASE_URL / METAAPI_TOKEN.
  // Per-key PUT upserts only the keys we manage.
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    const { status, data } = await api(
      "PUT",
      `/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
      { value },
    );
    if (status >= 400) {
      die(
        `env upsert ${key} failed HTTP ${status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    console.log(`[render-deploy] env upsert ok ${key}`);
  }
  console.log(
    `[render-deploy] env synced keys=${Object.keys(REQUIRED_ENV).length} (secrets untouched)`,
  );
}

function unwrapDeploy(data: unknown): Json | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Json;
  if (obj.deploy && typeof obj.deploy === "object") return obj.deploy as Json;
  if (typeof obj.id === "string" && obj.id.startsWith("dep-")) return obj;
  return obj.id ? obj : null;
}

async function triggerDeploy(serviceId: string, commitId?: string) {
  const body: Json = { clearCache: "do_not_clear" };
  if (commitId) body.commitId = commitId;
  const { status, data } = await api(
    "POST",
    `/services/${serviceId}/deploys`,
    body,
  );
  if (status >= 400) {
    // Deploy already running for same commit — treat as ok and wait on latest.
    const msg = JSON.stringify(data);
    if (
      status === 409 ||
      status === 429 ||
      /already|in progress|conflict/i.test(msg)
    ) {
      console.warn(
        `[render-deploy] trigger HTTP ${status} — will wait on latest deploy`,
        msg.slice(0, 240),
      );
      return null;
    }
    const hook = (process.env.RENDER_DEPLOY_HOOK_URL || "").trim();
    if (hook) {
      console.warn(
        `[render-deploy] API deploy HTTP ${status} — falling back to deploy hook`,
      );
      const href = commitId
        ? `${hook}${hook.includes("?") ? "&" : "?"}ref=${encodeURIComponent(commitId)}`
        : hook;
      const res = await fetch(href, { method: "POST" });
      if (!res.ok) die(`deploy hook HTTP ${res.status}`);
      console.log(`[render-deploy] deploy hook triggered`);
      return null;
    }
    die(`trigger deploy HTTP ${status}: ${msg}`);
  }
  const deploy = unwrapDeploy(data);
  const id = String(deploy?.id || "");
  console.log(
    `[render-deploy] deploy started id=${id || "(none)"} status=${deploy?.status} commit=${(deploy?.commit as Json | undefined)?.id || commitId || "latest"} http=${status}`,
  );
  return id || null;
}

async function waitDeploy(
  serviceId: string,
  deployId: string | null,
  commitId?: string,
  timeoutMs = 15 * 60_000,
) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let st = "";
    let seenCommit = "";
    let id = deployId || "";

    if (deployId) {
      const { status, data } = await api(
        "GET",
        `/services/${serviceId}/deploys/${deployId}`,
      );
      if (status >= 400) {
        console.warn(
          `[render-deploy] poll by id HTTP ${status} — fallback latest`,
        );
        deployId = null;
      } else {
        const deploy = unwrapDeploy(data) || {};
        st = String(deploy.status || "");
        seenCommit = String((deploy.commit as Json | undefined)?.id || "");
        id = String(deploy.id || deployId);
      }
    }

    if (!deployId) {
      const latest = await latestDeploy(serviceId);
      if (!latest) {
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      st = String(latest.status || "");
      seenCommit = String((latest.commit as Json | undefined)?.id || "");
      id = String(latest.id || "");
      // If a target commit is set, keep waiting until that commit is live (or fails).
      if (commitId && seenCommit && !seenCommit.startsWith(commitId.slice(0, 7)) && st === "live") {
        console.log(
          `[render-deploy] latest live is other commit=${seenCommit} — keep waiting for ${commitId}`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
    }

    console.log(
      `[render-deploy] poll id=${id || "?"} status=${st} commit=${seenCommit || "?"}`,
    );
    if (st === "live") {
      if (commitId && seenCommit && !seenCommit.startsWith(commitId.slice(0, 7))) {
        // still not our commit
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      console.log(`[render-deploy] LIVE ok`);
      return;
    }
    if (
      st === "build_failed" ||
      st === "update_failed" ||
      st === "canceled" ||
      st === "deactivated"
    ) {
      die(`deploy ended with status=${st}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  die("deploy wait timed out");
}

async function latestDeploy(serviceId: string) {
  const { status, data } = await api(
    "GET",
    `/services/${serviceId}/deploys?limit=1`,
  );
  if (status >= 400) return null;
  const rows = Array.isArray(data) ? data : [];
  const first = rows[0] as { deploy?: Json } | undefined;
  return first?.deploy || (first as Json) || null;
}

async function main() {
  const sync = argFlag("--sync-env") || process.env.RENDER_SYNC_ENV === "1";
  const wait = argFlag("--wait") || process.env.RENDER_WAIT === "1";
  const statusOnly = argFlag("--status");
  const commit =
    (process.env.RENDER_COMMIT || process.env.GITHUB_SHA || "").trim() ||
    undefined;

  const serviceId = await resolveServiceId();
  console.log(`[render-deploy] service=${SERVICE_NAME} id=${serviceId}`);

  if (statusOnly) {
    const d = await latestDeploy(serviceId);
    console.log(JSON.stringify({ serviceId, latest: d }, null, 2));
    return;
  }

  if (sync) await syncEnv(serviceId);

  const deployId = await triggerDeploy(serviceId, commit);
  if (wait) await waitDeploy(serviceId, deployId, commit);

  const latest = await latestDeploy(serviceId);
  console.log(
    JSON.stringify(
      {
        ok: true,
        serviceId,
        triggeredDeployId: deployId,
        latestStatus: latest?.status,
        latestCommit: (latest?.commit as Json | undefined)?.id,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  die(e instanceof Error ? e.message : String(e));
});
