import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { one, q } from "./db";
import type { User } from "./types";

const COOKIE = "pr_session";
const SESSION_DAYS = 14;
const DUMMY_HASH = "$2b$12$IlFp1redPIry/wj/sDLoz.hcTca3ti9JFIlT3LvLrkuTurRFH.vkm";

export const MIN_PASSWORD = 10;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

/** Always runs a compare, so a missing account takes as long as a wrong password. */
export async function checkPassword(password: string, hash: string | null) {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return ok && hash !== null;
}

export async function createSession(userId: string) {
  const token = newToken();
  await q("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + $3 * interval '1 day')", [
    sha256(token),
    userId,
    SESSION_DAYS,
  ]);
  await q("update users set last_login_at = now() where id = $1", [userId]);
  await q("delete from sessions where expires_at < now()");
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await q("delete from sessions where token_hash = $1", [sha256(token)]);
  jar.delete(COOKIE);
}

/** The signed-in user, or null. Looked up once per request. */
export const getUser = cache(async (): Promise<User | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return one<User>(
    `select u.id, u.name, u.email, u.role
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.status = 'active'`,
    [sha256(token)]
  );
});

export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** Admins and editors prepare the reports. Viewers only read them and answer questions. */
export const canEdit = (u: User) => u.role === "admin" || u.role === "editor";

/** Signed in as an admin or editor, or sent to the overview. */
export async function requireEditor(): Promise<User> {
  const user = await requireUser();
  if (!canEdit(user)) redirect("/");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}
