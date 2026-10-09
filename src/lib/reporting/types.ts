/*
 * Shared shapes for client reporting.
 *
 * Source records from ServiceM8 and Xero are normalised into the Sm* and Xero* types by
 * src/lib/reporting/data.ts. The report engines (contractor, projects, debtors, management)
 * are pure functions over these types, so they can be tested without a database.
 * Every amount is in pounds. Dates are YYYY-MM-DD in UK time unless the name says otherwise.
 */

export type LineClass = "labour_hourly" | "labour_fixed" | "parking" | "materials" | "other" | "ignore";
export type CostBasis = "hourly" | "labour_share" | "fixed_fee" | "actual_bill";
export type PaidBy = "contractor" | "business";
export type Treatment = "include" | "exclude" | "project";

/* Settings and inputs typed in by staff */

export type ReportSettings = {
  /** Short name of the business, for labels such as "Bought by Polkadot". */
  businessName: string;
  syncFrom: string;
  labourShare: number;
  cisRate: number;
  vatRate: number;
  /** ISO weekday the week ends on: 1 Monday ... 7 Sunday. Polkadot weeks run Friday to Thursday, so 4. */
  weekEndsOn: number;
  payRunLagDays: number;
  /** ServiceM8 categories whose jobs are projects, held out of the contractor figures. */
  projectCategories: string[];
  /** ServiceM8 categories for recalls, which are normally unpaid. */
  recallCategories: string[];
  /** Name of the Xero tracking category that splits sales, such as "Sales Type". */
  salesTypeTracking: string;
  chaseAfterHours: number;
  lowMarginPct: number;
};

export type Contractor = {
  id: string;
  name: string;
  sm8StaffUuids: string[];
  /** "staff" is someone who is not paid per job, such as a director. Their jobs are flagged. */
  kind: "contractor" | "staff";
  costBasis: "hourly" | "labour_share";
  hourlyRate: number | null;
  /** Cost a job from the contractor's Xero bill when a bill names the job. */
  useBills: boolean;
  /** The supplier name on their Xero bills, e.g. "JN Heating Solutions". */
  billSupplier: string;
  active: boolean;
  notes: string;
};

export type FixedFee = { id: string; name: string; amount: number; keywords: string[]; notes: string; sort: number };

export type Deduction = {
  id: string;
  contractorId: string;
  label: string;
  amount: number;
  startsOn: string | null;
  endsOn: string | null;
  /** Set for a one-off deduction in a single week. */
  weekEnding: string | null;
};

export type LineRule = { id: string; match: string; lineClass: LineClass; sort: number };

export type JobAdjustment = {
  jobNo: string;
  contractorId: string | null;
  costBasis: CostBasis | null;
  fixedFeeId: string | null;
  actualBill: number | null;
  billRef: string;
  materialsPaidBy: PaidBy | null;
  businessMaterials: number | null;
  contractorExtra: number | null;
  treatment: Treatment;
  weekEnding: string | null;
  note: string;
  updatedAt: string | null;
};

/* ServiceM8, normalised */

export type SmJob = {
  uuid: string;
  jobNo: string;
  /** Quote, Work Order, Completed or Unsuccessful. */
  status: string;
  active: boolean;
  /** Job date (YYYY-MM-DD) or null. */
  date: string | null;
  /** Completion date in UK time (YYYY-MM-DD), or null if not completed. */
  completionDate: string | null;
  completedByUuid: string | null;
  categoryUuid: string | null;
  categoryName: string;
  companyUuid: string | null;
  customer: string;
  /** Whether the customer is an individual (B2C) or a business (B2B). Null when unknown. */
  customerIsIndividual: boolean | null;
  site: string;
  description: string;
  workDone: string;
  /** The job's total as ServiceM8 shows it, including VAT. */
  totalIncVat: number;
  invoiceSent: boolean;
  /** When the invoice was sent, as an ISO timestamp, or null. */
  invoiceSentAt: string | null;
  quoteSent: boolean;
  editedAt: string | null;
};

export type SmLine = {
  uuid: string;
  jobUuid: string;
  materialUuid: string | null;
  name: string;
  quantity: number;
  /** Unit price excluding VAT. */
  unitPriceEx: number;
  /** quantity x unit price, excluding VAT. */
  totalEx: number;
  /** Unit cost recorded in ServiceM8, excluding VAT. */
  unitCost: number;
  sort: number;
};

export type SmActivity = {
  uuid: string;
  jobUuid: string;
  staffUuid: string;
  start: string | null;
  end: string | null;
  recorded: boolean;
  scheduled: boolean;
};

export type SmPayment = {
  uuid: string;
  jobUuid: string;
  amount: number;
  /** Payment date in UK time (YYYY-MM-DD). */
  date: string | null;
  method: string;
  note: string;
  isDeposit: boolean;
};

export type SmStaff = { uuid: string; name: string; active: boolean };

/* Xero, normalised */

export type XeroLine = {
  description: string;
  quantity: number;
  unitAmount: number;
  /** Line amount excluding VAT. */
  lineAmount: number;
  accountCode: string;
  taxAmount: number;
  tracking: { name: string; option: string }[];
};

export type XeroInvoice = {
  id: string;
  /** ACCREC is a sales invoice, ACCPAY a supplier bill. */
  type: "ACCREC" | "ACCPAY";
  number: string;
  reference: string;
  contactId: string;
  contactName: string;
  date: string;
  dueDate: string | null;
  /** DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED or DELETED. */
  status: string;
  subTotal: number;
  totalTax: number;
  total: number;
  amountDue: number;
  amountPaid: number;
  amountCredited: number;
  fullyPaidOn: string | null;
  /** UK CIS deduction on a bill, when Xero records one. */
  cisDeduction: number;
  lines: XeroLine[];
};

export type XeroAccount = { code: string; name: string; type: string; reportingCode?: string };

/* Report output shared by several engines */

export type Severity = "info" | "warn" | "error";

/** Something a person should look at. `ask` is the question to put to the client, when there is one. */
export type Flag = { code: string; severity: Severity; text: string; ask?: string };

export type Bucket = { label: string; count: number; amount: number };
