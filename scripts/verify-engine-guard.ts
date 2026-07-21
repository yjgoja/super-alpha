/**
 * engine-guard smoke test — no DB required
 *   npx tsx scripts/verify-engine-guard.ts
 */
import assert from "assert";
import {
  assertTradingDatabase,
  isFatalEngineError,
  isCloudColdError,
  parseDatabaseHost,
} from "../src/lib/engine-guard";

assert.equal(
  parseDatabaseHost("postgresql://u:p@dpg-xxx.ohio-postgres.render.com:5432/db"),
  "dpg-xxx.ohio-postgres.render.com",
);

assert.throws(
  () =>
    assertTradingDatabase({
      DATABASE_URL: "postgresql://u:p@ep-foo.us-east-2.aws.neon.tech/neondb",
      METAAPI_TOKEN: "x",
    } as NodeJS.ProcessEnv),
  /Neon/,
);

assert.doesNotThrow(() =>
  assertTradingDatabase({
    DATABASE_URL: "postgresql://u:p@dpg-xxx.ohio-postgres.render.com/db",
    METAAPI_TOKEN: "x",
    ENGINE_DB_HOST_ALLOW: "render.com",
  } as NodeJS.ProcessEnv),
);

assert.throws(
  () =>
    assertTradingDatabase({
      DATABASE_URL: "postgresql://u:p@somewhere.else.com/db",
      METAAPI_TOKEN: "x",
      ENGINE_DB_HOST_ALLOW: "render.com",
    } as NodeJS.ProcessEnv),
  /불일치/,
);

assert.ok(
  isFatalEngineError(
    new Error("ERROR: Your account or project has exceeded the compute time quota."),
  ),
);
assert.ok(isFatalEngineError(new Error("P1001: Can't reach database server")));
assert.ok(isCloudColdError("계좌 정보를 가져오지 못했습니다. 클라우드가 켜져 있는지 확인하세요."));
assert.ok(!isCloudColdError("spread too wide"));

console.log("OK verify-engine-guard");
