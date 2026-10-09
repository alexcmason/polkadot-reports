/** Admins manage connections and logins, editors prepare the reports, viewers read them and answer questions. */
export type Role = "admin" | "editor" | "viewer";

export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
};
