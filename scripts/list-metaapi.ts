/**
 * List MetaAPI accounts + open positions (live evidence for DCA readiness).
 */
const token = process.env.METAAPI_TOKEN?.trim() || "";
const PROVISIONING =
  process.env.METAAPI_PROVISIONING_URL ||
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const REGION = process.env.METAAPI_REGION || "new-york";
const CLIENT = `https://mt-client-api-v1.${REGION}.agiliumtrade.ai`;

async function api(base: string, path: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { "auth-token": token, Accept: "application/json" },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function main() {
  if (!token) throw new Error("METAAPI_TOKEN missing");
  const list = await api(PROVISIONING, "/users/current/accounts");
  console.log("accounts_http", list.status);
  const accounts = Array.isArray(list.data) ? list.data : [];
  console.log("account_count", accounts.length);

  for (const a of accounts as Array<Record<string, unknown>>) {
    const id = String(a._id || a.id || "");
    const login = String(a.login || "");
    const state = String(a.state || a.connectionStatus || "");
    console.log({ id, login, state, name: a.name, region: a.region });
    if (!id) continue;

    const info = await api(CLIENT, `/users/current/accounts/${id}/account-information`);
    const pos = await api(CLIENT, `/users/current/accounts/${id}/positions`);
    const positions = Array.isArray(pos.data) ? pos.data : [];
    console.log(
      "  balance/equity",
      (info.data as { balance?: number; equity?: number })?.balance,
      (info.data as { equity?: number })?.equity,
      "positions",
      positions.length,
    );
    for (const p of positions as Array<Record<string, unknown>>) {
      console.log("   ", {
        symbol: p.symbol,
        type: p.type,
        volume: p.volume,
        openPrice: p.openPrice,
        profit: p.profit,
      });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
