"use client";

import { useEffect } from "react";
import Link from "next/link";

/** Legacy route — membership no longer requires approval. */
export default function PendingPage() {
  useEffect(() => {
    window.location.replace("/connect");
  }, []);

  return (
    <main className="sa-shell flex min-h-screen items-center justify-center py-10">
      <section className="sa-panel text-center">
        <Link href="/connect" className="text-[var(--gold)]">
          계좌 연결로 이동…
        </Link>
      </section>
    </main>
  );
}
