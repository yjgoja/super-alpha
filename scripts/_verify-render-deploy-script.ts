/**
 * Offline sanity for render-deploy helpers (no live API calls).
 * Run: npx tsx scripts/_verify-render-deploy-script.ts
 */
import fs from "fs";
import path from "path";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const script = fs.readFileSync(
  path.join(process.cwd(), "scripts/render-deploy.ts"),
  "utf8",
);
const wf = fs.readFileSync(
  path.join(process.cwd(), ".github/workflows/render-engine-deploy.yml"),
  "utf8",
);
const yaml = fs.readFileSync(path.join(process.cwd(), "render.yaml"), "utf8");

check("script forbids bulk env replace", script.includes("NEVER bulk-replace"));
check(
  "script uses per-key env upsert",
  script.includes("/env-vars/${encodeURIComponent(key)}"),
);
check("script requires RENDER_API_KEY", script.includes("RENDER_API_KEY missing"));
check("METAAPI_PRICE_REST=0 in REQUIRED_ENV", script.includes('METAAPI_PRICE_REST: "0"'));
check("workflow waits for live", wf.includes("RENDER_WAIT: \"1\""));
check("workflow fails closed without secret", wf.includes("RENDER_API_KEY secret missing"));
check("render.yaml autoDeploy true", /autoDeploy:\s*true/.test(yaml));
check(
  "render.yaml PRICE_REST 0",
  /key:\s*METAAPI_PRICE_REST[\s\S]*?value:\s*"0"/.test(yaml),
);

if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
console.log("all ok");
