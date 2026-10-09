"use server";

import { redirect } from "next/navigation";
import { createHash, timingSafeEqual } from "node:crypto";
import { one, q } from "../db";
import { checkPassword, createSession, destroySession, hashPassword, MIN_PASSWORD, sha256 } from "../auth";
import { str } from "../format";

const digest = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export async function login(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password) redirect("/login?error=missing");

  const recent = await one<{ n: number }>(
    "select count(*)::int as n from login_attempts where email = $1 and succeeded = false and at > now() - interval '15 minutes'",
    [email]
  );
  if ((recent?.n ?? 0) >= 8) redirect("/login?error=locked");

  const user = await one<{ id: string; password_hash: string | null; status: string }>(
    "select id, password_hash, status from users where email = $1",
    [email]
  );
  const ok = await checkPassword(password, user?.status === "active" ? user.password_hash : null);
  await q("insert into login_attempts (email, succeeded) values ($1, $2)", [email, ok]);
  await q("delete from login_attempts where at < now() - interval '30 days'");
  if (!ok || !user) redirect("/login?error=invalid");

  await createSession(user.id);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

/** Creates the first admin login and names the business. Only works while there are no users at all. */
export async function setup(form: FormData) {
  const count = await one<{ n: number }>("select count(*)::int as n from users");
  if ((count?.n ?? 0) > 0) redirect("/login");

  const expected = process.env.SETUP_TOKEN ?? "";
  if (expected.length < 8 || !safeEqual(str(form, "token"), expected)) redirect("/setup?error=token");

  const business = str(form, "business").slice(0, 60);
  const name = str(form, "name");
  const email = str(form, "email").toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!business || !name || !email.includes("@")) redirect("/setup?error=details");
  if (password.length < MIN_PASSWORD) redirect("/setup?error=password");

  const user = await one<{ id: string }>(
    "insert into users (name, email, password_hash, role, status) values ($1, $2, $3, 'admin', 'active') returning id",
    [name, email, await hashPassword(password)]
  );
  await q(
    `insert into report_settings (id, business_name) values (true, $1)
     on conflict (id) do update set business_name = excluded.business_name, updated_at = now()`,
    [business]
  );
  await createSession(user!.id);
  redirect("/");
}

/** Sets a password from an invite or reset link, then signs the person in. */
export async function acceptInvite(form: FormData) {
  const token = str(form, "token");
  const password = String(form.get("password") ?? "");
  const back = `/invite/${encodeURIComponent(token)}`;
  if (password.length < MIN_PASSWORD) redirect(`${back}?error=password`);
  if (password !== String(form.get("confirm") ?? "")) redirect(`${back}?error=match`);

  const user = await one<{ id: string }>(
    `update users set password_hash = $2, status = 'active', invite_token_hash = null, invite_expires_at = null
      where invite_token_hash = $1 and invite_expires_at > now() and status <> 'disabled'
      returning id`,
    [sha256(token), await hashPassword(password)]
  );
  if (!user) redirect(`${back}?error=expired`);

  await q("delete from sessions where user_id = $1", [user.id]);
  await createSession(user.id);
  redirect("/");
}
