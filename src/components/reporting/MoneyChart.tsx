"use client";

import { ColumnChart, type Column } from "./ColumnChart";
import { gbp, gbp0 } from "@/lib/reporting/format";

/**
 * ColumnChart with money formatting, for use from server components (which cannot pass
 * a format function across to a client component).
 */
export function MoneyChart({ title, columns, highlight, whole = false }: { title: string; columns: Column[]; highlight?: string; whole?: boolean }) {
  return <ColumnChart title={title} columns={columns} highlight={highlight} money format={(v) => (whole ? gbp0(v) : gbp(v))} />;
}
