"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { one, q } from "../db";
import { newToken, requireAdmin, sha256 } from "../auth";
import { isUuid, ROLE_LABEL, str } from "../format";
import type { Role } from "../types";

const INVITE_DAYS = 7;
const PAGE = "/users";

async function issueInvite(userId: string): Promise<string> {
  const token = newToken();
  await q("update users set invite_token_hash = $2, invite_expires_at = now() + $3 * interval '1 day' where id = $1", [
    userId,
    sha256(token),
    INVITE_DAYS,
  ]);
  return token;
}

/** Adds a login and shows the admin a link to send. The person sets their own password from it. */
export async function inviteUser(form: FormData) {
  await requireAdmin();
  const name = str(form, "name");
  const email = str(form, "email").toLowerCase();
  const role = str(form, "role") as Role;
  if (!name || !email.includes("@") || !Object.hasOwn(ROLE_LABEL, role)) redirect(`${PAGE}?error=details`);
  if (await one("select 1 from users where email = $1", [email])) redirect(`${PAGE}?error=exists`);

  const user = await one<{ id: string }>("insert into users (name, email, role, status) values ($1, $2, $3, 'invited') returning id", [
    name,
    email,
    role,
  ]);
  const token = await issueInvite(user!.id);
  revalidatePath(PAGE);
  redirect(`${PAGE}?for=${user!.id}&invite=${token}#link`);
}

/** A fresh link. For someone already active it works as a password reset. */
export async function newInviteLink(form: FormData) {
  await requireAdmin();
  const id = str(form, "id");
  if (!isUuid(id) || !(await one("select 1 from users where id = $1 and status <> 'disabled'", [id]))) redirect(PAGE);
  const token = await issueInvite(id);
  redirect(`${PAGE}?for=${id}&invite=${token}#link`);
}

export async function updateUser(form: FormData) {
  const me = await requireAdmin();
  const id = str(form, "id");
  const target = isUuid(id) ? await one<{ status: string }>("select status from users where id = $1", [id]) : null;
  if (!target) redirect(PAGE);

  const name = str(form, "name");
  let role = str(form, "role") as Role;
  if (!name || !Object.hasOwn(ROLE_LABEL, role)) redirect(`${PAGE}?error=details`);
  let disabled = form.get("disabled") === "on";
  // You cannot lock yourself out or remove your own admin rights.
  if (id === me.id) {
    role = "admin";
    disabled = false;
  }
  const status = disabled ? "disabled" : target.status === "disabled" ? "active" : target.status;
  await q("update users set name = $2, role = $3, status = $4 where id = $1", [id, name, role, status]);
  if (disabled) await q("delete from sessions where user_id = $1", [id]);
  revalidatePath("/", "layout");
  redirect(`${PAGE}?saved=1`);
}
