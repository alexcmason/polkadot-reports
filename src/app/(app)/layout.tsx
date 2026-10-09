import Link from "next/link";
import { after } from "next/server";
import { logout } from "@/lib/actions/auth";
import { ROLE_LABEL } from "@/lib/format";
import { syncNow } from "@/lib/integrations/sync";
import { freshnessFor, openQueriesFor, reportingAccess } from "@/lib/reporting/context";
import { stamp } from "@/lib/reporting/format";
import { ReportTabs, type Tab } from "@/components/reporting/ReportTabs";
import { RefreshButton } from "@/components/reporting/RefreshButton";
import { Mark } from "@/components/Mark";

/** Data older than this is refreshed in the background when an editor opens a report. */
const STALE_HOURS = 4;

// Leaves room for a background refresh started after the page is sent.
export const maxDuration = 300;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, business, staff, canEdit, isAdmin } = await reportingAccess();
  const [fresh, openQueries] = await Promise.all([freshnessFor(), openQueriesFor()]);
  const connected = fresh.connected.servicem8 || fresh.connected.xero;
  const age = fresh.lastSyncAt ? Date.now() - Date.parse(fresh.lastSyncAt) : Infinity;
  // Never retried automatically after a failure, so a broken connection is not hammered.
  if (canEdit && connected && !fresh.problems.length && age > STALE_HOURS * 3_600_000) {
    after(async () => {
      await syncNow({ trigger: "manual", userId: user.id });
    });
  }

  const tabs: Tab[] = [
    { href: "/", label: "Overview" },
    { href: "/contractors", label: "Contractors" },
    ...(staff ? [{ href: "/jobs", label: "Job data" }] : []),
    { href: "/projects", label: "Projects" },
    { href: "/debtors", label: "Debtors" },
    { href: "/management", label: "Management accounts" },
    { href: "/queries", label: staff ? "Questions" : "Questions for you", count: openQueries },
    ...(staff ? [{ href: "/settings", label: "Settings" }] : []),
    ...(isAdmin ? [{ href: "/users", label: "Logins" }] : []),
  ];

  return (
    <div className="app">
      <header className="topbar">
        <Link href="/" className="wordmark">
          <Mark />
          <span>{business}</span>
          <span className="product">Reports</span>
        </Link>
        <div className="me">
          <div>
            <div className="who">{user.name}</div>
            <div className="role">{ROLE_LABEL[user.role]}</div>
          </div>
          <form action={logout}>
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <main className="main">
        <header className="report-head">
          <h1>{business}</h1>
          <div className="fresh">
            <span>
              Data from {[fresh.connected.servicem8 ? "ServiceM8" : "", fresh.connected.xero ? "Xero" : ""].filter(Boolean).join(" and ") || "no systems yet"}
              {connected ? `, refreshed ${stamp(fresh.lastSyncAt)}` : ""}
            </span>
            {canEdit && connected ? <RefreshButton /> : null}
          </div>
        </header>
        {fresh.problems.length && staff ? (
          <div className="banner err" role="alert">
            {fresh.problems.join(" ")} <Link href="/settings#connections">Open settings</Link>
          </div>
        ) : null}
        <ReportTabs tabs={tabs} />
        {children}
      </main>
    </div>
  );
}
