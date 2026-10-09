import { redirect } from "next/navigation";
import { one } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { login } from "@/lib/actions/auth";
import { Banner, Field, first, type Search } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { AuthBrand } from "@/components/AuthBrand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  missing: "Enter your email and password.",
  invalid: "That email and password do not match an active account.",
  locked: "Too many failed attempts. Wait 15 minutes, then try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  if (await getUser()) redirect("/");
  const users = await one<{ n: number }>("select count(*)::int as n from users");
  if ((users?.n ?? 0) === 0) redirect("/setup");
  const error = ERRORS[first((await searchParams).error)];

  return (
    <div className="auth">
      <AuthBrand />
      <div className="panel">
        <div className="box">
          <h1>Sign in</h1>
          {error ? <Banner kind="err">{error}</Banner> : null}
          <form action={login}>
            <Field label="Email">
              <input type="email" name="email" autoComplete="username" required />
            </Field>
            <Field label="Password">
              <input type="password" name="password" autoComplete="current-password" required />
            </Field>
            <SubmitButton pending="Signing in">Sign in</SubmitButton>
          </form>
          <p className="muted small">Forgotten your password? Ask an admin for a reset link.</p>
        </div>
      </div>
    </div>
  );
}
