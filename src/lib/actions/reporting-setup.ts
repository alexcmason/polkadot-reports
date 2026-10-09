"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireEditor } from "../auth";
import { safeReturn, str } from "../format";
import { listFees, saveFee } from "../reporting/store";
import { saveReportSettings } from "./reporting";

/* Setting up the reports for the first time. */

/** The settings form's percentage boxes. */
const PERCENT_FIELDS = ["labour_share", "cis_rate", "vat_rate", "low_margin_pct"];

/**
 * The report settings form, with its percentage boxes always read as percentages. The shared
 * action reads anything up to 1 as a fraction, so a box holding "1" (1%) would save as 100%.
 * Each box is turned into its fraction here first ("45" to 0.45, "1" to 0.01), which that
 * action keeps as it is. Access is checked by saveReportSettings.
 */
export async function saveReportSettingsForm(form: FormData) {
  for (const name of PERCENT_FIELDS) {
    const raw = str(form, name).replace(/[%\s]/g, "");
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) form.set(name, String(Math.min(n, 100) / 100));
  }
  await saveReportSettings(form);
}

/** The fixed fees on Polkadot's rate card, September 2026. Keywords are matched against job line names. */
const STANDARD_FEES: { name: string; amount: number; keywords: string[]; notes: string; sort: number }[] = [
  { name: "Combined boiler service and GSC", amount: 100, keywords: ["service and gas safety", "service & gas safety", "service and gsc"], notes: "Per visit", sort: 1 },
  { name: "Boiler service", amount: 80, keywords: ["boiler service"], notes: "Per service", sort: 2 },
  { name: "Gas Safety Certificate", amount: 80, keywords: ["gas safety certificate", "gsc", "cp12"], notes: "Per certificate", sort: 3 },
  { name: "Powerflush", amount: 250, keywords: ["powerflush"], notes: "Per job", sort: 4 },
  { name: "Boiler swap", amount: 450, keywords: ["boiler swap"], notes: "Per unit", sort: 5 },
  { name: "EICR standard", amount: 280, keywords: ["eicr"], notes: "Per report", sort: 6 },
  { name: "EICR key accounts", amount: 130, keywords: [], notes: "Per report. Choose it on the job, it is not matched by name.", sort: 7 },
];

/** Adds the standard fixed fees that are not there yet, matched by name. */
export async function loadStandardFees(form: FormData) {
  await requireEditor();
  const existing = new Set((await listFees()).map((f) => f.name.trim().toLowerCase()));
  let added = 0;
  for (const fee of STANDARD_FEES) {
    if (existing.has(fee.name.toLowerCase())) continue;
    await saveFee(fee);
    added++;
  }
  revalidatePath("/", "layout");
  const base = safeReturn(str(form, "return_to"), "/settings").split("#")[0];
  redirect(`${base}${base.includes("?") ? "&" : "?"}saved=fees&added=${added}#fees`);
}
