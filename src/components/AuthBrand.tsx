import { one } from "@/lib/db";
import { Mark } from "./Mark";

/** The coloured half of the sign-in screens: the business name once it is set, else just the app's name. */
export async function AuthBrand() {
  const row = await one<{ business_name: string }>("select business_name from report_settings where id").catch(() => null);
  const name = row?.business_name.trim() ?? "";
  return (
    <div className="brand">
      <div className="brand-mark">
        <Mark size={56} />
        <div>
          {name ? <div className="brand-name">{name}</div> : null}
          <div className="brand-product">{name ? "Reports" : "Business reports"}</div>
          <p className="brand-line">Contractor pay, projects, debtors and management accounts from ServiceM8 and Xero.</p>
        </div>
      </div>
    </div>
  );
}
