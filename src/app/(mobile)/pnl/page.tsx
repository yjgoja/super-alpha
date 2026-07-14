import { redirect } from "next/navigation";

/** PNL lives on Home (SuperMeta-style). Keep /pnl for old links. */
export default function PnlRedirectPage() {
  redirect("/home");
}
