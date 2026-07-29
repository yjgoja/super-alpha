export const SYMBOL_GROUPS = [
  {
    id: "forex",
    name: "Forex",
    symbols: ["EURUSD", "GBPUSD", "AUDUSD"],
  },
  {
    id: "metals",
    name: "귀금속",
    symbols: ["XAUUSD"],
  },
] as const;

export const SYMBOL_OPTIONS = SYMBOL_GROUPS.flatMap((g) => [...g.symbols]);

/**
 * 마틴9 계열 · 313 — 내부 id 유지. 사용자 노출 문구는 strategy-public.ts 사용.
 * 표시 순서: 스피드 → 스피드2배 → 스피드3배 → 안정 → 코어 → 지속 → 타임
 */
export const LOGIC_OPTIONS = [
  {
    id: "martin_9_068",
    name: "알파 스피드 로직 - 0.68%",
    desc: "회전이 빠른 스피드 프리셋",
  },
  {
    id: "martin_9_091",
    name: "알파 스피드 2배 - 0.91%",
    desc: "스피드 물타기 2배 늦은 프리셋",
  },
  {
    id: "martin_9_113",
    name: "알파 스피드 3배 - 1.13%",
    desc: "스피드 물타기 3배 늦은 프리셋",
  },
  {
    id: "martin_9_35",
    name: "알파 안정 로직 - 3.5%",
    desc: "안정 우선 프리셋",
  },
  {
    id: "martin_9_65",
    name: "알파 코어 로직 - 6.5%",
    desc: "균형형 코어 프리셋",
  },
  {
    id: "martin_9_gbp_sell_n9",
    name: "알파 GBP숏 코어 N9",
    desc: "GBPUSD SELL · 코어 간격 · 0.05×1.7 · 9회차 · TP10%",
  },
  {
    id: "martin_9_xau_buy_n5",
    name: "알파 XAU롱 코어 N5",
    desc: "XAUUSD BUY · 코어 간격 · 0.02×2 · 5회차 · TP10%",
  },
  {
    id: "dubai_bruno_313",
    name: "알파 지속 로직 - 2.35%",
    desc: "회차가 깊은 지속형 프리셋",
  },
  {
    id: "roulette_9",
    name: "알파 룰렛 로직",
    desc: "9회차 룰렛 스케일 프리셋",
  },
  {
    id: "john_kelly_1006",
    name: "알파 존캘리 로직",
    desc: "1006회차 존캘리 프리셋",
  },
  {
    id: "martin_9_068_time",
    name: "알파 스피드 타임 로직 - 0.68%",
    desc: "H8 세션 방향 + 스피드 마틴",
  },
  {
    id: "martin_9_35_time",
    name: "알파 안정 타임 로직 - 3.5%",
    desc: "H8 세션 방향 + 안정 마틴",
  },
  {
    id: "custom",
    name: "커스텀",
    desc: "고급 설정 전용",
  },
] as const;

/** 메인으로 노출하는 알파 전략 (룰렛·존캘리 = 테스트 전용, 비공개) */
export const PRIMARY_LOGIC_IDS = [
  "martin_9_068",
  "martin_9_091",
  "martin_9_113",
  "martin_9_35",
  "martin_9_65",
  "martin_9_gbp_sell_n9",
  "martin_9_xau_buy_n5",
  "dubai_bruno_313",
  "martin_9_068_time",
  "martin_9_35_time",
] as const;

export const PRIMARY_LOGIC_OPTIONS = LOGIC_OPTIONS.filter((l) =>
  (PRIMARY_LOGIC_IDS as readonly string[]).includes(l.id),
);

export type LogicId = (typeof LOGIC_OPTIONS)[number]["id"];

export const LOGIC_IDS = LOGIC_OPTIONS.map((l) => l.id) as [
  LogicId,
  ...LogicId[],
];

/** Named discovery presets — startLots / multiplier / entryCount + symbol/dir scope */
export const LOGIC_BOT_DEFAULTS: Partial<
  Record<
    LogicId,
    {
      startLots: number;
      entryMultiplier: number;
      entryCount: number;
      /** If set, logic only appears / applies for this symbol */
      requiredSymbol: string;
      /** If set, logic only appears / applies for this direction */
      requiredDirection: "BUY" | "SELL";
    }
  >
> = {
  martin_9_gbp_sell_n9: {
    startLots: 0.05,
    entryMultiplier: 1.7,
    entryCount: 9,
    requiredSymbol: "GBPUSD",
    requiredDirection: "SELL",
  },
  martin_9_xau_buy_n5: {
    startLots: 0.02,
    entryMultiplier: 2,
    entryCount: 5,
    requiredSymbol: "XAUUSD",
    requiredDirection: "BUY",
  },
};

export function logicBotDefaults(logic: string) {
  const id = normalizeLogicId(logic) as LogicId;
  return LOGIC_BOT_DEFAULTS[id] ?? null;
}

/** True if logic may be used on this symbol/direction (unscoped = always). */
export function logicAllowedForBot(
  logic: string,
  symbol: string,
  direction: "BUY" | "SELL",
) {
  const d = logicBotDefaults(logic);
  if (!d) return true;
  const sym = (symbol || "").toUpperCase();
  const dir = direction === "SELL" ? "SELL" : "BUY";
  if (d.requiredSymbol && d.requiredSymbol.toUpperCase() !== sym) return false;
  if (d.requiredDirection && d.requiredDirection !== dir) return false;
  return true;
}

/** 삭제·구버전 프리셋 → 현재 로직 */
export const LEGACY_LOGIC_ALIASES: Record<string, LogicId> = {
  dca_1000: "dubai_bruno_313",
  martin_9: "martin_9_068",
  martin_10: "martin_9_068",
  martin_11: "martin_9_068",
  martin_12: "martin_9_068",
};

export function normalizeLogicId(logic: string): string {
  return LEGACY_LOGIC_ALIASES[logic] ?? logic;
}

export function logicLabel(id: string) {
  const normalized = normalizeLogicId(id);
  return LOGIC_OPTIONS.find((l) => l.id === normalized)?.name || id;
}

export function isLogicId(id: string): id is LogicId {
  const normalized = normalizeLogicId(id);
  return LOGIC_OPTIONS.some((l) => l.id === normalized);
}
