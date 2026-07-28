/** Browser-only logout — clears session and blocks login-page auto-redirect. */
export async function logoutToLogin() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    /* still leave the page */
  }
  try {
    sessionStorage.setItem("sa_manual_logout", "1");
  } catch {
    /* ignore */
  }
  window.location.href = "/login?logout=1";
}

export function clearManualLogoutFlag() {
  try {
    sessionStorage.removeItem("sa_manual_logout");
  } catch {
    /* ignore */
  }
}

export function wasManualLogout(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (sessionStorage.getItem("sa_manual_logout") === "1") return true;
  } catch {
    /* ignore */
  }
  return false;
}
