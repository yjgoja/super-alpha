/**
 * Serialize per-account user toggles (master / symbol) so spam clicks
 * cannot interleave half-applied state with the live engine.
 */
const chains = new Map<string, Promise<unknown>>();

export function withAccountToggleLock<T>(
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(accountId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  chains.set(
    accountId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
