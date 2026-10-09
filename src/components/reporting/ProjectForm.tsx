import { saveProjectAction } from "@/lib/actions/reporting";
import { PROJECT_STATUS_LABEL, type ProjectRecord, type ProjectStatus } from "@/lib/reporting/projects";
import { Field } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";

const SALES_TYPES = ["RE", "IN", "S&M"];

const amount = (v: number | null | undefined) => (v === null || v === undefined ? "" : v.toFixed(2));

/**
 * The fields of a project, for adding one or editing it. Posts to saveProjectAction, which
 * opens the project page once saved. Pass `project` to edit, or `defaults` to pre-fill a new one.
 */
export function ProjectForm({
  returnTo,
  project,
  defaults,
  submitLabel,
}: {
  returnTo: string;
  project?: ProjectRecord;
  defaults?: Partial<ProjectRecord>;
  submitLabel: string;
}) {
  const v: Partial<ProjectRecord> = { ...defaults, ...project };
  const salesTypes = v.salesType && !SALES_TYPES.includes(v.salesType) ? [...SALES_TYPES, v.salesType] : SALES_TYPES;

  return (
    <form action={saveProjectAction} className="form">
      <input type="hidden" name="return_to" value={returnTo} />
      {project ? <input type="hidden" name="id" value={project.id} /> : null}

      <Field label="Customer">
        <input type="text" name="customer" defaultValue={v.customer ?? ""} required />
      </Field>
      <Field label="Site address">
        <input type="text" name="site" defaultValue={v.site ?? ""} />
      </Field>
      <Field label="Works" className="full">
        <input type="text" name="works" defaultValue={v.works ?? ""} />
      </Field>
      <Field label="Status">
        <select name="status" defaultValue={v.status ?? "quoted"}>
          {(Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[]).map((s) => (
            <option key={s} value={s}>
              {PROJECT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Xero sales type" hint="Should match the job category in ServiceM8">
        <select name="sales_type" defaultValue={v.salesType || "RE"}>
          {salesTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <Field label="ServiceM8 job numbers" hint="Separate with commas, e.g. 20290, 20290A">
        <input type="text" name="job_numbers" defaultValue={(v.jobNumbers ?? []).join(", ")} />
      </Field>
      <Field label="Our price override £" hint="Ex VAT. Leave blank to use the ServiceM8 quote">
        <input type="text" inputMode="decimal" name="price_override" defaultValue={amount(v.priceOverride)} />
      </Field>
      <Field label="Subcontractor">
        <input type="text" name="subcontractor" defaultValue={v.subcontractor ?? ""} />
      </Field>
      <Field label="Subcontractor in Xero" hint="Name on their Xero bills">
        <input type="text" name="sub_supplier" defaultValue={v.subSupplier ?? ""} />
      </Field>
      <Field label="Sub estimate no">
        <input type="text" name="sub_estimate_no" defaultValue={v.subEstimateNo ?? ""} />
      </Field>
      <Field label="Sub quoted £" hint="Ex VAT, from their estimate">
        <input type="text" inputMode="decimal" name="sub_quoted" defaultValue={amount(v.subQuoted)} />
      </Field>
      <Field label="Sub cost override £" hint="Leave blank to use what they have invoiced or quoted">
        <input type="text" inputMode="decimal" name="sub_cost_override" defaultValue={amount(v.subCostOverride)} />
      </Field>
      <fieldset className="field">
        <legend>Goodwill</legend>
        <label className="check">
          <input type="checkbox" name="goodwill" defaultChecked={!!v.goodwill} />
          Not charged to the client
        </label>
      </fieldset>
      <Field label="Notes" className="full">
        <textarea name="notes" defaultValue={v.notes ?? ""} rows={3} />
      </Field>
      <div className="full actions">
        <SubmitButton pending="Saving…">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
