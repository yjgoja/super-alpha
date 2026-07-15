/** Client/server-safe post-login / onboarding routing. */

export function resolvePostLoginPath(opts: {
  role: string;
  approvalStatus: string;
  hasBrokerAccount: boolean;
}): string {
  if (opts.role !== "admin" && opts.approvalStatus !== "approved") {
    return "/pending";
  }
  if (opts.role === "admin") return "/admin";
  if (opts.hasBrokerAccount) return "/home";
  return "/connect";
}

/** When a trader page requires a linked MetaAPI account. */
export function brokerGateRedirect(opts: {
  role?: string | null;
  metaApiAccountId?: string | null;
}): "/connect" | "/admin" | null {
  if (opts.metaApiAccountId) return null;
  if (opts.role === "admin") return "/admin";
  return "/connect";
}
