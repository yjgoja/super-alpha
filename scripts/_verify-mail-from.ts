/**
 * Offline checks for verification email From display-name encoding.
 * Run: npx tsx scripts/_verify-mail-from.ts
 */
import { encodeMimeDisplayName, fromAddress } from "../src/lib/mail";

let fail = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (pass) console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const encoded = encodeMimeDisplayName("슈퍼알파");
check("mime encodes korean", encoded.startsWith("=?UTF-8?B?") && encoded.endsWith("?="));
check(
  "mime roundtrip",
  Buffer.from(encoded.slice("=?UTF-8?B?".length, -"?=".length), "base64").toString("utf8") ===
    "슈퍼알파",
);

const prev = process.env.EMAIL_FROM;
delete process.env.EMAIL_FROM;
const def = fromAddress();
check("default has encoded brand", def.includes("=?UTF-8?B?"));
check("default has noreply", def.includes("<noreply@superalpha.kr>"));

process.env.EMAIL_FROM = "noreply@superalpha.kr";
check("bare email wraps brand", fromAddress().includes("=?UTF-8?B?") && fromAddress().includes("<noreply@superalpha.kr>"));

process.env.EMAIL_FROM = "???? <noreply@superalpha.kr>";
check("mojibake name replaced", !fromAddress().includes("????") && fromAddress().includes("=?UTF-8?B?"));

process.env.EMAIL_FROM = "Super Alpha <noreply@superalpha.kr>";
check("ascii name quoted or plain", fromAddress().includes("Super Alpha") || fromAddress().includes('"Super Alpha"'));

if (prev == null) delete process.env.EMAIL_FROM;
else process.env.EMAIL_FROM = prev;

if (fail > 0) {
  console.error(`\n${fail} failed`);
  process.exit(1);
}
console.log("\nAll mail From checks passed.");
console.log("sample:", fromAddress());
