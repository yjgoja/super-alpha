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
    id: "dca_1000",
    name: "1000차 DCA",
    desc: "익절/손절/물타기 = 바스켓 손익$ (시작로트 증거금×ROI% 환산)",
  },
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
    desc: "313차 표 · 익절/손절/물타기 = 손익$",
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

export function logicLabel(id: string) {
  return LOGIC_OPTIONS.find((l) => l.id === id)?.name || id;
}

export function isLogicId(id: string): id is LogicId {
  return LOGIC_OPTIONS.some((l) => l.id === id);
}
