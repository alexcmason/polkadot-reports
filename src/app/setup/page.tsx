import { redirect } from "next/navigation";
import { one } from "@/lib/db";
import { MIN_PASSWORD } from "@/lib/auth";
import { setup } from "@/lib/actions/auth";
import { Banner, Field, first, type Search } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { AuthBrand } from "@/components/AuthBrand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up" };

const ERRORS: Record<string, string> = {
  token: "The setup code does not match the SETUP_TOKEN set in Vercel.",
  details: "Enter the business name, your name and a valid email.",
  password: `Use a password of at least ${MIN_PASSWORD} characters.`,
};

export default async function SetupPage({ searchParams }: { searchParams: Search }) {
  const users = await one<{ n: number }>("select count(*)::int as n from users");
  if ((users?.n ?? 0) > 0) redirect("/login");
  const error = ERRORS[first((await searchParams).error)];

  return (
    <div className="auth">
      <AuthBrand />
      <div className="panel">
        <div className="box">
          <h1>Set up the reports</h1>
          <p className="muted">Name the business and create the first admin login. This page works once. After the first login exists it closes for good.</p>
          {error ? <Banner kind="err">{error}</Banner> : null}
          <form action={setup}>
            <Field label="Setup code" hint="The SETUP_TOKEN value from your Vercel settings.">
              <input type="password" name="token" autoComplete="off" required />
            </Field>
            <Field label="Business name" hint="A short name for labels, such as Polkadot. You can change it later in Settings.">
              <input type="text" name="business" autoComplete="organization" maxLength={60} required />
            </Field>
            <Field label="Your name">
              <input type="text" name="name" autoComplete="name" required />
            </Field>
            <Field label="Email">
              <input type="email" name="email" autoComplete="username" required />
            </Field>
            <Field label="Password" hint={`At least ${MIN_PASSWORD} characters.`}>
              <input type="password" name="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
            </Field>
            <SubmitButton pending="Setting up">Create admin login</SubmitButton>
          </form>
        </div>
      </div>
    </div>
  );
}
