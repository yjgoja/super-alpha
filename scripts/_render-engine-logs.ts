/**
 * Fetch recent super-alpha-engine logs from Render API.
 * Run: npx tsx --env-file=.env scripts/_render-engine-logs.ts
 * Or via GH Actions with RENDER_API_KEY secret.
 */
const API = "https://api.render.com/v1";
const SERVICE_NAME =
  (process.env.RENDER_SERVICE_NAME || "super-alpha-engine").trim();

async function api(path: string) {
  const key = (process.env.RENDER_API_KEY || "").trim();
  if (!key) throw new Error("RENDER_API_KEY missing");
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 500)}`);
  }
  return data;
}

async function resolveService() {
  const fixed = (process.env.RENDER_SERVICE_ID || "").trim();
  if (fixed) {
    const svc = (await api(`/services/${fixed}`)) as {
      service?: { id?: string; name?: string; ownerId?: string; suspended?: string };
      id?: string;
      name?: string;
      ownerId?: string;
    };
    const s = svc.service || svc;
    return {
      id: String(s.id || fixed),
      name: String(s.name || SERVICE_NAME),
      ownerId: String(s.ownerId || ""),
    };
  }
  const rows = (await api(
    `/services?name=${encodeURIComponent(SERVICE_NAME)}&limit=20`,
  )) as Array<{ service?: Record<string, unknown> }>;
  for (const row of rows) {
    const s = row.service || (row as unknown as Record<string, unknown>);
    if (String(s.name) === SERVICE_NAME) {
      return {
        id: String(s.id),
        name: String(s.name),
        ownerId: String(s.ownerId || ""),
      };
    }
  }
  throw new Error(`service ${SERVICE_NAME} not found`);
}

async function main() {
  const svc = await resolveService();
  console.log(JSON.stringify({ service: svc }, null, 2));

  const deploys = (await api(`/services/${svc.id}/deploys?limit=5`)) as Array<{
    deploy?: { id?: string; status?: string; commit?: { id?: string }; finishedAt?: string; createdAt?: string };
  }>;
  console.log(
    "\n=== recent deploys ===\n",
    JSON.stringify(
      deploys.map((d) => d.deploy || d),
      null,
      2,
    ),
  );

  let ownerId = svc.ownerId;
  if (!ownerId) {
    const owners = (await api(`/owners?limit=20`)) as Array<{
      owner?: { id?: string };
      id?: string;
    }>;
    ownerId = String(owners[0]?.owner?.id || owners[0]?.id || "");
  }
  if (!ownerId) throw new Error("ownerId missing — cannot fetch logs");

  const end = new Date();
  const start = new Date(end.getTime() - 6 * 60 * 60_000);
  const q = new URLSearchParams({
    ownerId,
    limit: "100",
    direction: "backward",
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  });
  q.append("resource", svc.id);
  q.append("text", "*FATAL*");
  // Also pull unfiltered recent app logs
  const qAll = new URLSearchParams({
    ownerId,
    limit: "80",
    direction: "backward",
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  });
  qAll.append("resource", svc.id);

  const fatal = await api(`/logs?${q.toString()}`);
  const recent = await api(`/logs?${qAll.toString()}`);

  const lines = (payload: unknown) => {
    const obj = payload as { logs?: Array<{ timestamp?: string; message?: string }> };
    return (obj.logs || []).map(
      (l) => `${l.timestamp || ""} ${String(l.message || "").slice(0, 500)}`,
    );
  };

  console.log("\n=== FATAL matching (6h) ===\n");
  for (const line of lines(fatal)) console.log(line);

  console.log("\n=== recent app logs (6h, newest first) ===\n");
  for (const line of lines(recent)) console.log(line);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
