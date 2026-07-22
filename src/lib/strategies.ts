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

export const LOGIC_OPTIONS = [
  {
    id: "martin_9",
    name: "마틴게일 9차",
    desc: "단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "martin_10",
    name: "마틴게일 10차",
    desc: "단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "martin_11",
    name: "마틴게일 11차",
    desc: "단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "martin_12",
    name: "마틴게일 12차",
    desc: "단계별 로트 증가 · 익절/손절/물타기 = 손익$",
  },
  {
    id: "dubai_bruno_313",
    name: "알파지속로직",
    desc: "정본 314레벨(L0+313 물타기) · 익절 ROI 회차별(20→25→30→45→60→70→100→110→125%) · 물타기 drop -20~-350% · 손절 225% · 바스켓 마진 ROI",
  },
  {
    id: "custom",
    name: "커스텀 전략",
    desc: "회차별 계약수·물타기$·익절$를 직접 편집",
  },
] as const;

export type LogicId = (typeof LOGIC_OPTIONS)[number]["id"];

export const LOGIC_IDS = LOGIC_OPTIONS.map((l) => l.id) as [
  LogicId,
  ...LogicId[],
];

/** 삭제·구명칭 프리셋 → 알파지속로직(내부 id dubai_bruno_313) */
export const LEGACY_LOGIC_ALIASES: Record<string, LogicId> = {
  dca_1000: "dubai_bruno_313",
  알파지속로직: "dubai_bruno_313",
  alpha_sustain: "dubai_bruno_313",
};

export function normalizeLogicId(logic: string): string {
  return LEGACY_LOGIC_ALIASES[logic] ?? logic;
}

export function logicLabel(id: string) {
  const normalized = normalizeLogicId(id);
  return LOGIC_OPTIONS.find((l) => l.id === normalized)?.name || id;
}

export function isLogicId(id: string): id is LogicId {
  return LOGIC_OPTIONS.some((l) => l.id === id);
}
