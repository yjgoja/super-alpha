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
    name: "두바이부르노 313차",
    desc: "실제 936레벨(L0+935 물타기) 표 · 익절 ROI=회차별(20/25/30%) · 손절 225% · 익절/손절/물타기 = 손익$",
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

/** 삭제된 프리셋 → 동일 표의 두바이부르노 */
export const LEGACY_LOGIC_ALIASES: Record<string, LogicId> = {
  dca_1000: "dubai_bruno_313",
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
