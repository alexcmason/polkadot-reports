import Link from "next/link";

/** Previous / current / next links for stepping through weeks or months. A missing link shows greyed out. */
export function Stepper({ prev, next, label, unit }: { prev: string | null; next: string | null; label: string; unit: string }) {
  const arrow = { fontSize: 18, minWidth: 44 } as const;
  return (
    <div className="stepper" role="group" aria-label={`Choose the ${unit}`}>
      {prev ? (
        <Link href={prev} aria-label={`Previous ${unit}`} style={arrow}>
          ‹
        </Link>
      ) : (
        <span className="disabled" aria-hidden="true" style={arrow}>
          ‹
        </span>
      )}
      <span style={{ borderLeft: "1px solid var(--line)", borderRight: "1px solid var(--line)", whiteSpace: "nowrap" }}>{label}</span>
      {next ? (
        <Link href={next} aria-label={`Next ${unit}`} style={{ ...arrow, borderLeft: 0 }}>
          ›
        </Link>
      ) : (
        <span className="disabled" aria-hidden="true" style={{ ...arrow, borderLeft: 0 }}>
          ›
        </span>
      )}
    </div>
  );
}
