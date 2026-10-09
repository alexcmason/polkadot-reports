"use client";

/** A submit button that asks before going ahead. */
export function ConfirmButton({
  children,
  message,
  className = "link danger",
  formAction,
}: {
  children: React.ReactNode;
  message: string;
  className?: string;
  formAction?: (form: FormData) => void | Promise<void>;
}) {
  return (
    <button
      type="submit"
      className={className}
      formAction={formAction}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
