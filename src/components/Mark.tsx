/** The app's mark: three dots. Decorative; the business name always sits beside it. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.14" />
      <circle cx="10" cy="20" r="4" fill="currentColor" />
      <circle cx="17" cy="12" r="4" fill="currentColor" opacity="0.75" />
      <circle cx="23" cy="21" r="3" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
