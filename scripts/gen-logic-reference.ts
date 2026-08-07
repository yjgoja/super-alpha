/**
 * 로직 사양서 생성기 — 코드에서 직접 뽑는다.
 *
 *   npm run docs:logics            > docs/LOGIC-REFERENCE.md
 *   npm run docs:logics -- --json  > 로직 데이터(JSON)
 *
 * 손으로 옮겨적은 문서는 코드가 바뀌면 조용히 틀려진다. 이 스크립트는
 * strategies.ts / table-logics.ts / dca1000.ts 의 실제 함수를 호출하므로
 * 봇이 쓰는 값과 항상 같다.
 *
 * 참조 시세는 --px 로 덮어쓴다 (기본값은 아래 REF_PRICE).
 *   npm run docs:logics -- --px XAUUSD=4200,GBPUSD=1.35
 */
import {
  LOGIC_OPTIONS,
  PRIMARY_LOGIC_IDS,
  LOGIC_BOT_DEFAULTS,
  LEGACY_LOGIC_ALIASES,
  SYMBOL_GROUPS,
} from "../src/lib/strategies";
import {
  getMartin9Defense,
  isMartin9TimeLogic,
  isBulkLogic,
  isSustainedBulkLogic,
  isMartinLogic,
  defaultEntryMultiplier,
  getTableLevels,
  lotsForLogicLevel,
  resolveLiveStopLossPct,
  resolveLiveTakeProfitPct,
} from "../src/lib/table-logics";
import {
  mt5UsedMargin,
  roiPctToUsd,
  MT5_BROKER_LEVERAGE_DEFAULT,
} from "../src/lib/dca1000";

/** 2026-08-08 실계좌 포지션 평균가 기준. --px 로 덮어쓸 수 있다. */
const REF_PRICE: Record<string, number> = {
  XAUUSD: 4202.89,
  GBPUSD: 1.34604,
  EURUSD: 1.15596,
  AUDUSD: 0.70517,
};

const argv = process.argv.slice(2);
const pxArg = argv[argv.indexOf("--px") + 1];
if (argv.includes("--px") && pxArg) {
  for (const pair of pxArg.split(",")) {
    const [s, v] = pair.split("=");
    if (s && v && Number(v) > 0) REF_PRICE[s.trim().toUpperCase()] = Number(v);
  }
}

const SYMBOLS = SYMBOL_GROUPS.flatMap((g) => [...g.symbols]);
const LEV = MT5_BROKER_LEVERAGE_DEFAULT;
const primary = new Set<string>(PRIMARY_LOGIC_IDS as readonly string[]);

/**
 * 엔진이 실제로 쓰는 회차 상한 (meta-engine.ts).
 * martinMaxLevels() 가 아니다 — 그 함수는 에디터용이고 지속 로직에 12 를 돌려준다.
 * 엔진은 지속 로직에서 표 전체를 강제한다.
 */
function engineMaxLevels(logic: string, entryCount?: number) {
  const levels = getTableLevels(logic);
  if (isSustainedBulkLogic(logic)) return levels.length;
  return Math.max(1, Math.min(levels.length, entryCount && entryCount > 0 ? entryCount : levels.length));
}

type Rung = {
  level: number;
  addLots: number;
  cumLots: number;
  dropPct: number;
  tpPct: number;
  marginUsd: number;
  tpUsd: number;
  slUsd: number;
};

/** 로직 × 종목 사다리를 실제 함수로 계산한다. */
function ladderFor(logicId: string, symbol: string): Rung[] {
  const levels = getTableLevels(logicId);
  const scope = LOGIC_BOT_DEFAULTS[logicId as keyof typeof LOGIC_BOT_DEFAULTS];
  const startLots = scope?.startLots ?? 0.01;
  const mult = scope?.entryMultiplier ?? defaultEntryMultiplier(logicId);
  const max = engineMaxLevels(logicId, scope?.entryCount);
  const slPct = resolveLiveStopLossPct(logicId, null);
  const tpFallback = resolveLiveTakeProfitPct(logicId, null);
  const price = REF_PRICE[symbol] ?? 1;

  const out: Rung[] = [];
  let cum = 0;
  for (let i = 0; i < max; i++) {
    const row = levels[Math.min(i, levels.length - 1)];
    const add = lotsForLogicLevel(logicId, i, startLots, mult, row?.size ?? 10, null);
    cum = Math.round((cum + add) * 100) / 100;
    const marginUsd = mt5UsedMargin({ symbol, lots: cum, avgPrice: price, brokerLeverage: LEV });
    const tpPct = isBulkLogic(logicId) && row?.profit > 0 ? row.profit : tpFallback;
    out.push({
      level: i,
      addLots: add,
      cumLots: cum,
      dropPct: i === 0 ? 0 : (row?.drop ?? 0),
      tpPct,
      marginUsd: Math.round(marginUsd * 100) / 100,
      tpUsd: Math.round(roiPctToUsd(marginUsd, tpPct) * 100) / 100,
      slUsd: Math.round(roiPctToUsd(marginUsd, slPct) * 100) / 100,
    });
  }
  return out;
}

/** 회차가 많으면 이정표만 추린다 (항상 첫 회차와 마지막 회차 포함). */
function sample(rungs: Rung[], want = 12): Rung[] {
  if (rungs.length <= want) return rungs;
  const idx = new Set<number>([0, rungs.length - 1]);
  for (let k = 1; k < want - 1; k++) {
    idx.add(Math.round((k * (rungs.length - 1)) / (want - 1)));
  }
  return [...idx].sort((a, b) => a - b).map((i) => rungs[i]);
}

const kindOf = (id: string) =>
  isMartin9TimeLogic(id)
    ? "time"
    : isSustainedBulkLogic(id)
      ? "sustained"
      : isBulkLogic(id)
        ? "table"
        : isMartinLogic(id)
          ? "martin"
          : "other";

const KIND_KO: Record<string, string> = {
  martin: "마틴",
  time: "타임 · H8 세션",
  sustained: "지속형",
  table: "표 기반",
  other: "기타",
};

const logics = LOGIC_OPTIONS.filter((l) => l.id !== "custom").map((l) => {
  const scope = LOGIC_BOT_DEFAULTS[l.id as keyof typeof LOGIC_BOT_DEFAULTS];
  const d = getMartin9Defense(l.id);
  // 전용 로직은 지정 종목만, 나머지는 전 종목
  const syms = scope ? [scope.requiredSymbol] : SYMBOLS;
  const perSymbol = syms.map((s) => {
    const rungs = ladderFor(l.id, s);
    const last = rungs[rungs.length - 1];
    return {
      symbol: s,
      refPrice: REF_PRICE[s] ?? null,
      finalCumLots: last.cumLots,
      finalMarginUsd: last.marginUsd,
      finalSlUsd: last.slUsd,
      finalTpUsd: last.tpUsd,
      rungs: sample(rungs),
      totalRungs: rungs.length,
    };
  });
  return {
    id: l.id,
    name: l.name,
    desc: l.desc,
    public: primary.has(l.id),
    kind: kindOf(l.id),
    kindKo: KIND_KO[kindOf(l.id)],
    chartPct: d?.chartPct ?? null,
    maxLevels: engineMaxLevels(l.id, scope?.entryCount),
    multiplier: scope?.entryMultiplier ?? defaultEntryMultiplier(l.id),
    startLots: scope?.startLots ?? 0.01,
    slPct: resolveLiveStopLossPct(l.id, null),
    tpPct: resolveLiveTakeProfitPct(l.id, null),
    scope: scope
      ? { symbol: scope.requiredSymbol, direction: scope.requiredDirection, entryCount: scope.entryCount }
      : null,
    perSymbol,
  };
});

const payload = {
  refPrice: REF_PRICE,
  leverage: LEV,
  symbolGroups: SYMBOL_GROUPS,
  aliases: LEGACY_LOGIC_ALIASES,
  logics,
};

if (argv.includes("--json")) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

/* ---------------- markdown ---------------- */
const out: string[] = [];
const w = (s = "") => out.push(s);
const usd = (v: number) =>
  "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

w("# 슈퍼알파 로직 사양서");
w();
w("> `npm run docs:logics` 가 코드에서 생성합니다. 손으로 고치지 마세요.");
w(`> 생성: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
w();
w(`**기준** — 브로커 레버리지 1:${LEV} · 첫 배팅 0.01 (전용 로직은 각자 값)`);
w();
w("**참조 시세** — " + SYMBOLS.map((s) => `${s} ${REF_PRICE[s]}`).join(" · "));
w();
w("손절 금액은 `마진 × 손절ROI%`. 마진은 종목·누적랏·시세·레버리지로 정해지므로,");
w("시세가 움직이면 금액도 함께 움직입니다. 아래 숫자는 위 참조 시세 기준입니다.");
w();

w("## 끝까지 갔을 때 손절 금액");
w();
w("각 로직이 마지막 회차까지 채운 뒤 손절될 때의 금액입니다.");
w();
w("| 로직 | 공개 | 방어폭 | 회차 | 손절 ROI | " + SYMBOLS.join(" | ") + " |");
w("|---|:--:|--:|--:|--:|" + SYMBOLS.map(() => "--:").join("|") + "|");
for (const l of logics) {
  const cells = SYMBOLS.map((s) => {
    const ps = l.perSymbol.find((p) => p.symbol === s);
    return ps ? `**${usd(ps.finalSlUsd)}**` : "—";
  });
  w(
    `| ${l.name} | ${l.public ? "✅" : "🔒"} | ${l.chartPct == null ? "—" : l.chartPct + "%"} | ` +
      `${l.maxLevels} | −${l.slPct}% | ${cells.join(" | ")} |`,
  );
}
w();
w("전용 로직(GBP숏·XAU롱)은 지정 종목에서만 동작하므로 나머지 칸은 `—` 입니다.");
w();

w("## 로직별 상세");
w();
for (const l of logics) {
  w(`### ${l.name}`);
  w();
  w(`\`${l.id}\` · ${l.kindKo} · ${l.public ? "공개" : "테스트 전용"}`);
  w();
  w(`${l.desc}`);
  w();
  w(
    `- 방어폭 **${l.chartPct == null ? "—" : l.chartPct + "%"}** · 최대 **${l.maxLevels}회차** · 물타기 배수 **×${l.multiplier}** · 첫 배팅 **${l.startLots}**`,
  );
  w(`- 익절 **${l.tpPct}%** · 손절 **−${l.slPct}%**`);
  if (l.scope) w(`- **${l.scope.symbol} ${l.scope.direction} 전용**`);
  w();
  for (const ps of l.perSymbol) {
    w(`**${ps.symbol}** (참조가 ${ps.refPrice}) — 끝까지 손절 **${usd(ps.finalSlUsd)}** · 누적 ${ps.finalCumLots} lots`);
    w();
    w("| 회차 | 누적 랏 | 물타기 트리거 | 익절 | 익절 $ | 손절 $ |");
    w("|--:|--:|--:|--:|--:|--:|");
    for (const r of ps.rungs) {
      w(
        `| L${r.level} | ${r.cumLots} | ${r.level === 0 ? "진입" : "−" + r.dropPct + "%"} | ` +
          `${r.tpPct}% | ${usd(r.tpUsd)} | ${usd(r.slUsd)} |`,
      );
    }
    if (ps.rungs.length < ps.totalRungs) {
      w();
      w(`  전체 ${ps.totalRungs}회차 중 이정표만 표시했습니다.`);
    }
    w();
  }
}

const aliases = Object.entries(LEGACY_LOGIC_ALIASES);
if (aliases.length) {
  w("## 구버전 ID 대응");
  w();
  w("| 옛 ID | 현재 로직 |");
  w("|---|---|");
  for (const [f, t] of aliases) w(`| \`${f}\` | \`${t}\` |`);
  w();
}

console.log(out.join("\n"));
