import { one } from "@/lib/db";
import { MIN_PASSWORD, sha256 } from "@/lib/auth";
import { acceptInvite } from "@/lib/actions/auth";
import { Banner, Field, first, type Search } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { AuthBrand } from "@/components/AuthBrand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set your password" };

const ERRORS: Record<string, string> = {
  password: `Use a password of at least ${MIN_PASSWORD} characters.`,
  match: "The two passwords do not match.",
  expired: "This link has expired or has already been used. Ask for a new one.",
};

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Search }) {
  const { token } = await params;
  const error = ERRORS[first((await searchParams).error)];
  const person = await one<{ name: string; email: string }>(
    "select name, email from users where invite_token_hash = $1 and invite_expires_at > now() and status <> 'disabled'",
    [sha256(token)]
  );

  return (
    <div className="auth">
      <AuthBrand />
      <div className="panel">
        <div className="box">
          {person ? (
            <>
              <h1>Set your password</h1>
              <p className="muted">
                {person.name}, you will sign in as {person.email}.
              </p>
              {error ? <Banner kind="err">{error}</Banner> : null}
              <form action={acceptInvite}>
                <input type="hidden" name="token" value={token} />
                <Field label="Password" hint={`At least ${MIN_PASSWORD} characters.`}>
                  <input type="password" name="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
                </Field>
                <Field label="Repeat password">
                  <input type="password" name="confirm" autoComplete="new-password" minLength={MIN_PASSWORD} required />
                </Field>
                <SubmitButton pending="Saving">Save password and sign in</SubmitButton>
              </form>
            </>
          ) : (
            <>
              <h1>Link not valid</h1>
              <Banner kind="err">{ERRORS.expired}</Banner>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
