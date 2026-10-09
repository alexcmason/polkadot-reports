import { requireAdmin } from "@/lib/auth";
import { q } from "@/lib/db";
import { inviteUser, newInviteLink, updateUser } from "@/lib/actions/users";
import { ROLE_LABEL } from "@/lib/format";
import { appOrigin } from "@/lib/url";
import { stamp } from "@/lib/reporting/format";
import type { Role } from "@/lib/types";
import { Avatar, Banner, Field, first, type Search } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/reporting/CopyButton";

export const metadata = { title: "Logins" };

type Person = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  invite_live: boolean;
  last_login_at: string | null;
};

const ERRORS: Record<string, string> = {
  details: "Enter a name, a valid email and a role.",
  exists: "Someone with that email already has a login.",
};

const ROLE_CHIP: Record<Role, string> = { admin: "solid", editor: "green", viewer: "" };

const ROLE_HINT: Record<Role, string> = {
  admin: "Admin: everything, including connections and logins",
  editor: "Editor: prepares the reports, adjusts jobs, chases debtors, asks questions",
  viewer: "Viewer: reads the reports and answers questions",
};

const MATRIX: [string, string, string, string][] = [
  ["Reports and Excel downloads", "Yes", "Yes", "Yes, except Job data"],
  ["Answer questions", "Yes", "Yes", "Yes"],
  ["Ask questions, chase debtors, edit projects", "Yes", "Yes", "No"],
  ["Adjust jobs, rates, fees and deductions", "Yes", "Yes", "No"],
  ["Refresh data from ServiceM8 and Xero", "Yes", "Yes", "No"],
  ["Connect ServiceM8 and Xero", "Yes", "No", "No"],
  ["Logins", "Yes", "No", "No"],
];

export default async function UsersPage({ searchParams }: { searchParams: Search }) {
  const me = await requireAdmin();
  const sp = await searchParams;
  const error = ERRORS[first(sp.error)];
  const invite = first(sp.invite);
  const people = await q<Person>(
    `select id, name, email, role, status,
            (invite_expires_at is not null and invite_expires_at > now()) as invite_live,
            to_char(last_login_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_login_at
       from users
      order by case role when 'admin' then 0 when 'editor' then 1 else 2 end, name`
  );
  const invited = people.find((p) => p.id === first(sp.for));
  const link = invite && invited ? `${await appOrigin()}/invite/${encodeURIComponent(invite)}` : "";
  const statusText = (p: Person) =>
    p.status === "active"
      ? `Active${p.last_login_at ? `, last signed in ${stamp(p.last_login_at)}` : ""}`
      : p.status === "disabled"
        ? "Disabled"
        : p.invite_live
          ? "Invited, not joined yet"
          : "Invite expired";

  return (
    <>
      {first(sp.saved) ? <Banner kind="ok">Saved.</Banner> : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      {link && invited ? (
        <section className="card" id="link">
          <div className="card-head">
            <h2>Send this link to {invited.name}</h2>
            <span className="small muted">It works once and lasts 7 days. It is only shown now.</span>
          </div>
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <input id="invite-link" type="text" readOnly value={link} className="copy" style={{ flex: "1 1 320px" }} aria-label="Invite link" />
            <CopyButton target="invite-link" label="Copy link" />
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Logins</h2>
          <span className="small muted">
            {people.length} {people.length === 1 ? "person" : "people"}
          </span>
        </div>
        <div className="scroll">
          <table className="tbl" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <PersonRows key={p.id} p={p} isMe={p.id === me.id} statusText={statusText(p)} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Add a login</h2>
          <span className="small muted">You get a link to send them. They choose their own password.</span>
        </div>
        <div className="card-body">
          <form action={inviteUser} className="form">
            <Field label="Name">
              <input type="text" name="name" required maxLength={120} />
            </Field>
            <Field label="Email">
              <input type="email" name="email" required maxLength={200} />
            </Field>
            <Field label="Role" className="full">
              <select name="role" defaultValue="viewer">
                {(["viewer", "editor", "admin"] as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_HINT[r]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="full">
              <SubmitButton pending="Creating link">Create invite link</SubmitButton>
            </div>
          </form>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>What each role can do</h2>
        </div>
        <div className="scroll">
          <table className="tbl" style={{ minWidth: 600 }}>
            <thead>
              <tr>
                <th></th>
                <th>Admin</th>
                <th>Editor</th>
                <th>Viewer</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, i) => (
                    <td key={i} className={i === 0 ? "strong" : cell === "No" ? "small muted" : "small"}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function PersonRows({ p, isMe, statusText }: { p: Person; isMe: boolean; statusText: string }) {
  const editId = `edit-${p.id}`;
  return (
    <>
      <tr>
        <td>
          <div className="owner" style={{ whiteSpace: "normal" }}>
            <Avatar name={p.name} />
            <span>
              <span className="strong" style={{ fontSize: 14 }}>
                {p.name}
                {isMe ? " (you)" : ""}
              </span>
              <br />
              <span className="muted">{p.email}</span>
            </span>
          </div>
        </td>
        <td>
          <span className={`chip ${ROLE_CHIP[p.role]}`}>{ROLE_LABEL[p.role]}</span>
        </td>
        <td className={`small ${p.status === "active" ? "" : "muted"}`}>{statusText}</td>
        <td style={{ textAlign: "right" }}>
          <a href={`#${editId}`} className="link">
            Change
          </a>
        </td>
      </tr>
      <tr id={editId} className="edit-row collapsed">
        <td colSpan={4}>
          <form action={updateUser} className="mini" style={{ alignItems: "end", padding: "8px 0" }}>
            <input type="hidden" name="id" value={p.id} />
            <Field label="Name">
              <input type="text" name="name" defaultValue={p.name} required maxLength={120} />
            </Field>
            {isMe ? (
              <Field label="Role" hint="You cannot remove your own admin rights.">
                <input type="hidden" name="role" value="admin" />
                <input type="text" value="Admin" disabled />
              </Field>
            ) : (
              <Field label="Role">
                <select name="role" defaultValue={p.role}>
                  {(["admin", "editor", "viewer"] as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {isMe ? null : (
              <label className="check">
                <input type="checkbox" name="disabled" defaultChecked={p.status === "disabled"} />
                Disabled: cannot sign in
              </label>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <SubmitButton pending="Saving">Save</SubmitButton>
              {p.status !== "disabled" ? (
                <button type="submit" className="btn" formAction={newInviteLink} formNoValidate>
                  {p.status === "active" ? "Password reset link" : "New invite link"}
                </button>
              ) : null}
              <a href="#" className="link">
                Close
              </a>
            </div>
          </form>
        </td>
      </tr>
    </>
  );
}
