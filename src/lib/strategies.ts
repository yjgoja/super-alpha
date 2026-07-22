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
 * 표시 순서: 스피드 → 안정 → 코어 → 지속
 */
export const LOGIC_OPTIONS = [
  {
    id: "martin_9_068",
    name: "알파 스피드 로직",
    desc: "회전이 빠른 스피드 프리셋",
  },
  {
    id: "martin_9_35",
    name: "알파 안정 로직",
    desc: "안정 우선 프리셋",
  },
  {
    id: "martin_9_65",
    name: "알파 코어 로직",
    desc: "균형형 코어 프리셋",
  },
  {
    id: "dubai_bruno_313",
    name: "알파 지속 로직",
    desc: "회차가 깊은 지속형 프리셋",
  },
  {
    id: "custom",
    name: "커스텀",
    desc: "고급 설정 전용",
  },
] as const;

/** 메인으로 노출하는 알파 전략 4개 */
export const PRIMARY_LOGIC_IDS = [
  "martin_9_068",
  "martin_9_35",
  "martin_9_65",
  "dubai_bruno_313",
] as const;

export const PRIMARY_LOGIC_OPTIONS = LOGIC_OPTIONS.filter((l) =>
  (PRIMARY_LOGIC_IDS as readonly string[]).includes(l.id),
);

export type LogicId = (typeof LOGIC_OPTIONS)[number]["id"];

export const LOGIC_IDS = LOGIC_OPTIONS.map((l) => l.id) as [
  LogicId,
  ...LogicId[],
];

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
