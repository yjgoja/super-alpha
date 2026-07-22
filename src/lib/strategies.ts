export const SYMBOL_GROUPS = [
  {
    id: "forex",
    name: "Forex",
    symbols: [
      "AUDUSD",
      "EURUSD",
      "GBPUSD",
      "NZDUSD",
      "AUDJPY",
      "USDJPY",
      "EURGBP",
      "USDCAD",
      "USDCHF",
      "AUDCAD",
      "AUDCHF",
      "AUDNZD",
      "AUDSGD",
      "CADCHF",
      "CADJPY",
      "CHFJPY",
      "EURAUD",
      "EURCAD",
      "EURCHF",
      "EURCZK",
      "EURHUF",
      "EURJPY",
      "EURNOK",
      "EURNZD",
      "EURPLN",
      "EURSEK",
      "EURSGD",
      "EURZAR",
      "GBPAUD",
      "GBPCAD",
      "GBPCHF",
      "GBPJPY",
      "GBPNZD",
      "GBPSEK",
      "GBPSGD",
      "NZDCAD",
      "NZDCHF",
      "NZDJPY",
      "NZDSGD",
      "USDBRL",
      "USDCNH",
      "USDCZK",
      "USDDKK",
      "USDHKD",
      "USDHUF",
      "USDKRW",
      "USDMXN",
      "USDNOK",
      "USDPLN",
      "USDSEK",
      "USDSGD",
      "USDZAR",
    ],
  },
  {
    id: "energy",
    name: "원자재",
    symbols: ["WTI", "XBRUSD", "XTIUSD", "XNGUSD"],
  },
  {
    id: "metals",
    name: "귀금속",
    symbols: ["XAUUSD", "XAUEUR", "XAGUSD", "XAGEUR", "XPDUSD", "XPTUSD"],
  },
  {
    id: "crypto",
    name: "암호화폐",
    symbols: ["BTCUSD"],
  },
] as const;

export const SYMBOL_OPTIONS = SYMBOL_GROUPS.flatMap((g) => [...g.symbols]);

/**
 * 슈퍼알파 기본 전략 4개 (표시명만 알파○○로직).
 * 내부 id는 엔진/DB 호환을 위해 유지.
 */
export const LOGIC_OPTIONS = [
  {
    id: "dubai_bruno_313",
    name: "알파지속로직",
    desc: "314레벨(L0+313 물타기) · 회차 TP 20→125% · drop -20~-350% · 손절 225% · 바스켓 마진 ROI",
  },
  {
    id: "martin_9",
    name: "알파안정로직",
    desc: "9회차 마틴 · 단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "martin_10",
    name: "알파균형로직",
    desc: "10회차 마틴 · 단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "martin_11",
    name: "알파공격로직",
    desc: "11회차 마틴 · 단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "martin_12",
    name: "알파돌파로직",
    desc: "12회차 마틴 · 단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "custom",
    name: "커스텀 전략",
    desc: "회차별 계약수·물타기$·익절$를 직접 편집",
  },
] as const;

/** 메인으로 노출하는 알파 전략 4개 */
export const PRIMARY_LOGIC_IDS = [
  "dubai_bruno_313",
  "martin_9",
  "martin_10",
  "martin_11",
] as const;

export const PRIMARY_LOGIC_OPTIONS = LOGIC_OPTIONS.filter((l) =>
  (PRIMARY_LOGIC_IDS as readonly string[]).includes(l.id),
);

export type LogicId = (typeof LOGIC_OPTIONS)[number]["id"];

export const LOGIC_IDS = LOGIC_OPTIONS.map((l) => l.id) as [
  LogicId,
  ...LogicId[],
];

/** 삭제·구명칭 → 현재 로직 id */
export const LEGACY_LOGIC_ALIASES: Record<string, LogicId> = {
  dca_1000: "dubai_bruno_313",
  알파지속로직: "dubai_bruno_313",
  alpha_sustain: "dubai_bruno_313",
  두바이부르노: "dubai_bruno_313",
  두바이부르노313차: "dubai_bruno_313",
  마틴게일9차: "martin_9",
  마틴게일10차: "martin_10",
  마틴게일11차: "martin_11",
  마틴게일12차: "martin_12",
  알파안정로직: "martin_9",
  알파균형로직: "martin_10",
  알파공격로직: "martin_11",
  알파돌파로직: "martin_12",
  alpha_stable: "martin_9",
  alpha_balanced: "martin_10",
  alpha_attack: "martin_11",
  alpha_breakout: "martin_12",
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
  return LOGIC_OPTIONS.some((l) => l.id === normalized || l.id === id);
}

export function isPrimaryLogicId(id: string) {
  const normalized = normalizeLogicId(id);
  return (PRIMARY_LOGIC_IDS as readonly string[]).includes(normalized);
}
