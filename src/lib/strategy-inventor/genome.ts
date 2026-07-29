/**
 * Novel strategy inventor — genome DNA.
 *
 * v1 focus: invent ladders that compile to live-runnable `custom` StrategyPayload.
 * Frontier sketches may require engine work (runnable=false) and are never auto-applied.
 */

export type DirectionPolicy = "BUY" | "SELL" | "DUAL";

/** How adverse ROI drops are spaced across DCA rounds (L1..Ln). L0 drop is always 0. */
export type SpacingFamily =
  | "arithmetic"
  | "geometric"
  | "fibonacci"
  | "clustered"
  | "accelerating"
  | "decelerating"
  | "freeform_mono";

/** How lot sizes evolve across rounds. */
export type LotFamily =
  | "martingale"
  | "anti_martingale"
  | "flat"
  | "fibonacci"
  | "u_shape"
  | "freeform_positive";

/** Basket exit policy (v1 = single basket ROI TP/SL, engine-native). */
export type ExitFamily = "basket_roi_tp_sl";

export type StrategyGenomeV1 = {
  version: 1;
  /** Short human id, e.g. invent-a1b2c3 */
  id: string;
  /** Structural families — not a registered martin_9_* preset knob set */
  spacingFamily: SpacingFamily;
  lotFamily: LotFamily;
  exitFamily: ExitFamily;
  direction: DirectionPolicy;
  /** Total rounds including L0 (2..60) */
  rounds: number;
  /** Knobs interpreted by the chosen families */
  spacing: {
    /** First adverse ROI% step (L1), or scale base */
    baseDropRoi: number;
    /** geometric ratio / accel factor / cluster width helper */
    growth: number;
  };
  lots: {
    startLots: number;
    /** martingale/anti multiplier; ignored by flat */
    multiplier: number;
  };
  takeProfitPct: number;
  stopLossPct: number;
  repeatEnabled: boolean;
  stopOnSl: boolean;
  /** Always true for v1 ladder genomes that map to custom */
  runnable: true;
  requiresEngine: [];
};

/** Non-executable idea seed for future engine expansion (never auto-applied). */
export type MechanismSketch = {
  version: 1;
  id: string;
  runnable: false;
  requiresEngine: string[];
  headline: string;
  entryRule: string;
  dcaRule: string;
  exitRule: string;
  notes: string;
};

export type InventedCandidate =
  | { kind: "ladder"; genome: StrategyGenomeV1; label: string }
  | { kind: "sketch"; sketch: MechanismSketch; label: string };

export const SPACING_FAMILIES: SpacingFamily[] = [
  "arithmetic",
  "geometric",
  "fibonacci",
  "clustered",
  "accelerating",
  "decelerating",
  "freeform_mono",
];

export const LOT_FAMILIES: LotFamily[] = [
  "martingale",
  "anti_martingale",
  "flat",
  "fibonacci",
  "u_shape",
  "freeform_positive",
];

export const DIRECTION_POLICIES: DirectionPolicy[] = ["BUY", "SELL", "DUAL"];
