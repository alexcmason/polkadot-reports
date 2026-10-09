import type { Flag } from "@/lib/reporting/types";

/** A job's flags as small coloured notes. Renders nothing when there are none. */
export function Flags({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return (
    <div className="flags">
      {flags.map((f, i) => (
        <span key={`${f.code}-${i}`} className={`flag ${f.severity === "info" ? "" : f.severity}`}>
          {f.text}
        </span>
      ))}
    </div>
  );
}

/** Whether a flag needs someone to look at it: anything above info, or anything with a question attached. */
export const needsLook = (flags: Flag[]) => flags.some((f) => f.severity !== "info" || !!f.ask);

/** Row class for the worst flag: "error", "flagged" or none. */
export function flagRowClass(flags: Flag[]): string | undefined {
  if (flags.some((f) => f.severity === "error")) return "error";
  if (needsLook(flags)) return "flagged";
  return undefined;
}
