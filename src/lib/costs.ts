/** MetaAPI cloud-g2 high reliability rates (USD, excl. VAT) — from MetaApi billing. */
export const META_RATES = {
  g2HighPerHour: 0.0126,
  g2DeployFee: 0.0756,
  undeployedPerHour: 0.00105,
  addAccount: 2.1,
  hoursPerMonth: 730,
} as const;

export function monthlyDeployedCost(count: number) {
  return count * META_RATES.g2HighPerHour * META_RATES.hoursPerMonth;
}

export function monthlyUndeployedCost(count: number) {
  return count * META_RATES.undeployedPerHour * META_RATES.hoursPerMonth;
}

export function fmtUsd(n: number) {
  return `$${n.toFixed(2)}`;
}
