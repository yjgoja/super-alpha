/** Client/server-safe post-login / onboarding routing. */

export function resolvePostLoginPath(opts: {
  role: string;
  approvalStatus: string;
  hasBrokerAccount: boolean;
}): string {
  // Rejected accounts are blocked at login API — never land here normally
  if (opts.role !== "admin" && opts.approvalStatus === "rejected") {
    return "/pending";
  }
  if (opts.role === "admin") return "/admin";
  // Always home after login/register — connect is prompted on trading actions
  return "/home";
}

/** Soft check: pages may browse without MetaAPI; trading actions should prompt /connect. */
export function isMt5Linked(opts: { metaApiAccountId?: string | null }): boolean {
  return Boolean(opts.metaApiAccountId);
}

/** @deprecated Prefer soft ConnectPrompt — kept for admin-only hard redirects */
export function brokerGateRedirect(opts: {
  role?: string | null;
  metaApiAccountId?: string | null;
}): "/connect" | "/admin" | null {
  if (opts.metaApiAccountId) return null;
  if (opts.role === "admin") return "/admin";
  return null; // no hard redirect for traders
}
