/**
 * 로직 사양서 생성기 — 코드에서 직접 뽑는다.
 *
 *   npx tsx scripts/gen-logic-reference.ts > docs/LOGIC-REFERENCE.md
 *
 * 손으로 옮겨적은 문서는 코드가 바뀌면 조용히 틀려진다. 이 스크립트는
 * strategies.ts / table-logics.ts / presets 를 직접 읽으므로 항상 실제와 같다.
 */
import {
  LOGIC_OPTIONS,
  PRIMARY_LOGIC_IDS,
  LOGIC_BOT_DEFAULTS,
  LEGACY_LOGIC_ALIASES,
  SYMBOL_GROUPS,
} from "../src/lib/strategies";
import {
  MARTIN9_DEFENSE,
  getMartin9Defense,
  isMartin9TimeLogic,
  isBulkLogic,
  isSustainedBulkLogic,
  isMartinLogic,
  isTableLogic,
  martinMaxLevels,
  defaultEntryMultiplier,
  getTableLevels,
  getTableLeverage,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
  TABLE_LOGIC_IDS,
} from "../src/lib/table-logics";

const out: string[] = [];
const w = (s = "") => out.push(s);

const primary = new Set<string>(PRIMARY_LOGIC_IDS as readonly string[]);

function kind(id: string) {
  if (isMartin9TimeLogic(id)) return "타임 (H8 세션 방향)";
  if (isSustainedBulkLogic(id)) return "지속형 (깊은 회차)";
  if (isBulkLogic(id)) return "표 기반";
  if (isMartinLogic(id)) return "마틴";
  return "기타";
}

w("# 슈퍼알파 로직 사양서");
w();
w("> 이 문서는 `scripts/gen-logic-reference.ts` 가 코드에서 생성합니다.");
w("> 손으로 고치지 마세요. 코드를 바꾸고 다시 생성하면 됩니다.");
w(`> 생성 시각: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
w();

w("## 거래 가능 종목");
w();
for (const g of SYMBOL_GROUPS) w(`- **${g.name}**: ${g.symbols.join(", ")}`);
w();

w("## 한눈에 보기");
w();
w("| 로직 ID | 이름 | 공개 | 분류 | 차트 방어폭 | 최대 회차 | 기본 배수 | TP | SL |");
w("|---|---|:--:|---|--:|--:|--:|--:|--:|");
for (const l of LOGIC_OPTIONS) {
  if (l.id === "custom") continue;
  const d = getMartin9Defense(l.id);
  const tp = resolveLiveTakeProfitPct(l.id, null);
  const sl = resolveLiveStopLossPct(l.id, null);
  w(
    `| \`${l.id}\` | ${l.name} | ${primary.has(l.id) ? "✅" : "🔒"} | ${kind(l.id)} | ` +
      `${d ? d.chartPct + "%" : "—"} | ${martinMaxLevels(l.id)} | ` +
      `×${defaultEntryMultiplier(l.id)} | ${tp}% | ${sl}% |`,
  );
}
w();
w("✅ 공개 (사용자 선택 가능) · 🔒 비공개 (테스트 전용)");
w();

w("## 종목·방향 전용 로직");
w();
const scoped = Object.entries(LOGIC_BOT_DEFAULTS);
if (scoped.length === 0) {
  w("없음 — 모든 로직이 전 종목에 적용됩니다.");
} else {
  w("아래 로직은 지정된 종목·방향에서만 동작합니다.");
  w();
  w("| 로직 ID | 종목 | 방향 | 첫 배팅 | 배수 | 회차 |");
  w("|---|---|---|--:|--:|--:|");
  for (const [id, d] of scoped) {
    if (!d) continue;
    w(
      `| \`${id}\` | ${d.requiredSymbol} | ${d.requiredDirection} | ` +
        `${d.startLots} | ×${d.entryMultiplier} | ${d.entryCount} |`,
    );
  }
}
w();

w("## 로직별 상세");
w();
for (const l of LOGIC_OPTIONS) {
  if (l.id === "custom") continue;
  const d = getMartin9Defense(l.id);
  const scope = LOGIC_BOT_DEFAULTS[l.id as keyof typeof LOGIC_BOT_DEFAULTS];
  w(`### ${l.name}`);
  w();
  w(`- **ID**: \`${l.id}\``);
  w(`- **설명**: ${l.desc}`);
  w(`- **공개 여부**: ${primary.has(l.id) ? "공개" : "비공개 (테스트 전용)"}`);
  w(`- **분류**: ${kind(l.id)}`);
  if (d) {
    w(`- **차트 방어폭**: ${d.chartPct}%  (drop 배율 ×${d.dropScale})`);
  }
  w(`- **최대 회차**: ${martinMaxLevels(l.id)}회`);
  w(`- **기본 물타기 배수**: ×${defaultEntryMultiplier(l.id)}`);
  w(`- **익절 / 손절**: ${resolveLiveTakeProfitPct(l.id, null)}% / ${resolveLiveStopLossPct(l.id, null)}%`);
  if (isTableLogic(l.id)) w(`- **레버리지 기준**: ${getTableLeverage(l.id)}`);
  if (scope) {
    w(
      `- **전용 조건**: ${scope.requiredSymbol} ${scope.requiredDirection} 전용 · ` +
        `첫 배팅 ${scope.startLots} · ×${scope.entryMultiplier} · ${scope.entryCount}회차`,
    );
  }

  const levels = getTableLevels(l.id);
  if (levels.length > 0) {
    const show = levels.slice(0, 10);
    w();
    w(`  회차별 진입 조건 (앞 ${show.length}회 / 전체 ${levels.length}회)`);
    w();
    w("  | 회차 | 하락 트리거 | 목표 수익 |");
    w("  |--:|--:|--:|");
    show.forEach((lv, i) => w(`  | L${i} | ${lv.drop}% | ${lv.profit}% |`));
  }
  w();
}

const aliases = Object.entries(LEGACY_LOGIC_ALIASES);
if (aliases.length > 0) {
  w("## 구버전 ID 대응표");
  w();
  w("아래 옛 ID는 자동으로 현재 로직으로 변환됩니다.");
  w();
  w("| 옛 ID | 현재 로직 |");
  w("|---|---|");
  for (const [from, to] of aliases) w(`| \`${from}\` | \`${to}\` |`);
  w();
}

w("## 표 기반 로직 목록");
w();
w(TABLE_LOGIC_IDS.map((t) => `\`${t}\``).join(", "));
w();

w("## 차트 방어폭 프리셋 원본");
w();
w("| 프리셋 | 차트 % | drop 배율 | 손절 % | 익절 % |");
w("|---|--:|--:|--:|--:|");
for (const [id, p] of Object.entries(MARTIN9_DEFENSE)) {
  w(`| \`${id}\` | ${p.chartPct} | ${p.dropScale} | ${p.stopLossPct} | ${p.takeProfitPct} |`);
}
w();

console.log(out.join("\n"));
