/*
 * The client's September 2026 master workbook, as ServiceM8 and Xero records.
 * Each JOBS entry is one row of its Job Data tab: what was completed, by whom, the hours,
 * rate, parking and materials charged, and what Xero shows. Costs are NOT given here;
 * the engine works them out from the rates, fees, bills and the few decisions the
 * director confirmed (typed in as adjustments, as staff would in the app).
 */
import type { Contractor, Deduction, FixedFee, JobAdjustment, ReportSettings, SmJob, SmLine, SmStaff, XeroInvoice } from "../types";
import type { ContractorInputs } from "../contractor";

// [completed, contractor, job no, units, rate, parking, materials, other, Xero ex VAT, line kind]
// Line kind: H hourly labour, F fixed-price labour, or the name of the fee line on the job.
type Row = [string, string, string, number, number, number, number, number, number, string];

export const JOBS: Row[] = [
  ["2026-09-04", "JSD Drainage", "21073", 1, 165, 0, 0, 0, 165, "H"],
  ["2026-09-10", "JSD Drainage", "21217", 1, 165, 0, 0, 0, 165, "H"],
  ["2026-09-04", "Jack Nichols", "21107", 2, 125, 0, 0, 0, 250, "H"],
  ["2026-09-04", "Jack Nichols", "21158", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-07", "Jack Nichols", "21143", 1, 125, 11.41, 0, 0, 136.41, "H"],
  ["2026-09-09", "Jack Nichols", "21171", 1.5, 125, 0, 0, 0, 187.5, "H"],
  ["2026-09-04", "John Smyth", "21167", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-07", "Mohammad Reza", "21148", 1, 125, 17, 0, 0, 142, "H"],
  ["2026-09-08", "Mohammad Reza", "21219", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-08", "Mohammad Reza", "21230", 4, 125, 0, 0, 0, 500, "H"],
  ["2026-09-07", "Robert Moghal", "21198", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-09", "Robert Moghal", "21215", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-09", "UNLMTD Electrical", "20963", 1, 360, 0, 0, 0, 360, "EICR"],
  ["2026-09-11", "Jack Nichols", "21226", 1, 125, 0, 0, 0, 125, "Boiler service"],
  ["2026-09-11", "Jack Nichols", "21231", 1, 125, 0, 85.78, 0, 210.78, "H"],
  ["2026-09-14", "Jack Nichols", "20924", 1.5, 125, 0, 0, 0, 187.5, "H"],
  ["2026-09-15", "Jack Nichols", "21234", 3.5, 125, 22.73, 57.2, 0, 517.43, "H"],
  ["2026-09-16", "Jack Nichols", "21246", 1, 125, 0, 0, 0, 125, "Boiler service"],
  ["2026-09-16", "Jack Nichols", "21255", 2, 125, 43.6, 0, 0, 293.6, "H"],
  ["2026-09-16", "Jack Nichols", "21280", 2, 125, 0, 21.14, 0, 271.14, "H"],
  ["2026-09-17", "Jack Nichols", "21240", 4, 125, 0, 250, 0, 750, "H"],
  ["2026-09-17", "Jack Nichols", "21256", 4, 125, 0, 2473.88, 0, 2973.88, "H"],
  ["2026-09-11", "Mohammad Reza", "21242", 4, 90, 13, 137, 0, 510, "H"],
  ["2026-09-12", "Mohammad Reza", "21233", 3, 125, 0, 581.99, 0, 956.99, "H"],
  ["2026-09-14", "Mohammad Reza", "21095", 2, 125, 0, 0, 0, 250, "H"],
  ["2026-09-14", "Mohammad Reza", "21117", 1, 125, 8, 15, 0, 148, "H"],
  ["2026-09-14", "Mohammad Reza", "21151", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-14", "Mohammad Reza", "21224", 2, 125, 0, 230, 0, 480, "H"],
  ["2026-09-14", "Mohammad Reza", "21225", 2, 125, 0, 0, 0, 250, "H"],
  ["2026-09-14", "Mohammad Reza", "21236", 1, 125, 0, 20, 0, 145, "H"],
  ["2026-09-14", "Mohammad Reza", "21238", 2, 125, 17, 30, 0, 297, "H"],
  ["2026-09-14", "Mohammad Reza", "21239", 1, 125, 0, 67, 0, 192, "H"],
  ["2026-09-14", "Mohammad Reza", "21241", 2, 125, 0, 80, 0, 330, "H"],
  ["2026-09-15", "Mohammad Reza", "21260", 2, 125, 7, 36, 0, 293, "H"],
  ["2026-09-16", "Mohammad Reza", "21269", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-11", "Robert Moghal", "21208", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-11", "Robert Moghal", "21222", 1, 125, 0, 0, 0, 125, "Boiler service"],
  ["2026-09-14", "Robert Moghal", "21207", 1, 210, 6.2, 0, 0, 216.2, "Boiler service and gas safety certificate"],
  ["2026-09-14", "Robert Moghal", "21249", 1.5, 125, 10.05, 175.25, 0, 372.8, "H"],
  ["2026-09-16", "Robert Moghal", "21259", 2, 125, 13, 40.52, 0, 303.52, "H"],
  ["2026-09-14", "UNLMTD Electrical", "21232", 1, 443.3, 0, 0, 0, 443.3, "F"],
  ["2026-09-15", "UNLMTD Electrical", "21237", 1, 360, 0, 0, 0, 360, "EICR"],
  ["2026-09-17", "UNLMTD Electrical", "21116", 1, 125, 7, 57.2, 0, 189.2, "H"],
  ["2026-09-21", "Felix Cairns", "20833", 4, 125, 21.12, 90, 0, 611.12, "H"],
  ["2026-09-24", "Felix Cairns", "21341", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-24", "Felix Cairns", "21348", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-21", "JSD Drainage", "21165", 1, 165, 0, 0, 0, 165, "H"],
  ["2026-09-22", "Jack Nichols", "21297", 1, 125, 3.75, 0, 0, 128.75, "Boiler service"],
  ["2026-09-22", "Jack Nichols", "21304", 1, 125, 13.9, 0, 0, 138.9, "Boiler service"],
  ["2026-09-21", "Julian Giles", "21288", 1, 450, 0, 259.1, 0, 709.1, "F"],
  ["2026-09-23", "Julian Giles", "21347", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-24", "Julian Giles", "21294", 1, 850, 0, 272, 0, 1122, "F"],
  ["2026-09-24", "Julian Giles", "21305", 1, 125, 12.01, 12, 0, 149.01, "H"],
  ["2026-09-18", "Mohammad Reza", "21245", 1, 90, 13, 5, 0, 108, "H"],
  ["2026-09-18", "Mohammad Reza", "21262", 1.5, 125, 17, 13, 0, 217.5, "H"],
  ["2026-09-18", "Mohammad Reza", "21279", 1.5, 125, 0, 42, 0, 229.5, "H"],
  ["2026-09-18", "Mohammad Reza", "21296", 1, 125, 8, 0, 0, 133, "H"],
  ["2026-09-21", "Mohammad Reza", "21266", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-22", "Mohammad Reza", "21258", 1, 125, 10, 0, 0, 135, "H"],
  ["2026-09-22", "Mohammad Reza", "21261", 1, 450, 0, 576, 0, 1026, "F"],
  ["2026-09-22", "Mohammad Reza", "21267", 1, 125, 0, 300, 0, 425, "H"],
  ["2026-09-21", "Ray Graham", "21281", 2, 125, 9.8, 180, 0, 439.8, "H"],
  ["2026-09-18", "Robert Moghal", "21227A", 2, 125, 0, 30, 0, 280, "H"],
  ["2026-09-18", "Robert Moghal", "21289", 1, 125, 0, 0, 0, 125, "H"],
  ["2026-09-18", "Robert Moghal", "21290", 1, 125, 0, 0, 0, 125, "Gas Safety Certificate"],
  ["2026-09-18", "Robert Moghal", "21291", 1, 125, 0, 4.5, 0, 129.5, "H"],
  ["2026-09-18", "UNLMTD Electrical", "20941", 1, 471.9, 0, 0, 0, 471.9, "F"],
  ["2026-09-22", "UNLMTD Electrical", "21277", 1, 328.9, 0, 0, 0, 328.9, "F"],
];

const staffUuid = (name: string) => `staff-${name.toLowerCase().replace(/\W+/g, "-")}`;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function contractor(name: string, extra: Partial<Contractor>): Contractor {
  return {
    id: `c-${staffUuid(name)}`,
    name,
    sm8StaffUuids: [staffUuid(name)],
    kind: "contractor",
    costBasis: "hourly",
    hourlyRate: 80,
    useBills: false,
    billSupplier: "",
    active: true,
    notes: "",
    ...extra,
  };
}

export const CONTRACTORS: Contractor[] = [
  contractor("Felix Cairns", {}),
  contractor("Jack Nichols", { billSupplier: "JN Heating Solutions" }),
  contractor("John Smyth", { billSupplier: "Smyth Plumbing and Heating" }),
  contractor("JSD Drainage", { hourlyRate: 110, useBills: true, billSupplier: "JSD Solutions 24/7" }),
  contractor("Julian Giles", { hourlyRate: 90, billSupplier: "Julian Giles Plumbing" }),
  contractor("Mohammad Reza", { costBasis: "labour_share", hourlyRate: null, billSupplier: "Mohammad Reza Mohammadi" }),
  contractor("Ray Graham", { costBasis: "labour_share", hourlyRate: null, useBills: true, billSupplier: "Buzzwell" }),
  contractor("Robert Moghal", {}),
  contractor("UNLMTD Electrical", { useBills: true, billSupplier: "UNLMTD Electrical & Fire" }),
  contractor("Jack Ronan", { kind: "staff", hourlyRate: null }),
];

export const FEES: FixedFee[] = [
  { id: "fee-combined", name: "Combined boiler service and GSC", amount: 100, keywords: ["service and gas safety", "service & gas safety", "service and gsc"], notes: "", sort: 1 },
  { id: "fee-service", name: "Boiler service", amount: 80, keywords: ["boiler service"], notes: "", sort: 2 },
  { id: "fee-gsc", name: "Gas Safety Certificate", amount: 80, keywords: ["gas safety certificate", "gsc", "cp12"], notes: "", sort: 3 },
  { id: "fee-powerflush", name: "Powerflush", amount: 250, keywords: ["powerflush"], notes: "", sort: 4 },
  { id: "fee-swap", name: "Boiler swap", amount: 450, keywords: ["boiler swap"], notes: "", sort: 5 },
  { id: "fee-eicr", name: "EICR standard", amount: 280, keywords: ["eicr"], notes: "", sort: 6 },
];

const MO = CONTRACTORS.find((c) => c.name === "Mohammad Reza")!.id;
export const DEDUCTIONS: Deduction[] = [
  { id: "d1", contractorId: MO, label: "Van", amount: 100, startsOn: "2026-09-10", endsOn: null, weekEnding: null },
  { id: "d2", contractorId: MO, label: "Van insurance adjustment", amount: 5, startsOn: "2026-09-10", endsOn: null, weekEnding: null },
  { id: "d3", contractorId: MO, label: "Franchise fee", amount: 50, startsOn: "2026-09-10", endsOn: null, weekEnding: null },
  { id: "d4", contractorId: MO, label: "Commusoft licence", amount: 13.75, startsOn: "2026-09-10", endsOn: null, weekEnding: null },
];

const adj = (jobNo: string, a: Partial<JobAdjustment>): JobAdjustment => ({
  jobNo,
  contractorId: null,
  costBasis: null,
  fixedFeeId: null,
  actualBill: null,
  billRef: "",
  materialsPaidBy: null,
  businessMaterials: null,
  contractorExtra: null,
  treatment: "include",
  weekEnding: null,
  note: "",
  updatedAt: null,
  ...a,
});

// What the director confirmed on 28 September, for bills that do not name the job.
export const ADJUSTMENTS: JobAdjustment[] = [
  adj("20963", { costBasis: "actual_bill", actualBill: 232, billRef: "UNLMTD 4264" }),
  adj("21232", { costBasis: "actual_bill", actualBill: 310, billRef: "UNLMTD 4285" }),
  adj("21237", { costBasis: "actual_bill", actualBill: 232, billRef: "UNLMTD 4305" }),
  adj("21281", { costBasis: "actual_bill", actualBill: 180, billRef: "Buzzwell 4441" }),
  adj("21256", { materialsPaidBy: "business", businessMaterials: 2473.88, contractorExtra: 100, note: "Pump and saniflo bought by Polkadot. JN paid about 100 extra." }),
];

const bill = (number: string, supplier: string, date: string, net: number, reference: string, description: string): XeroInvoice => ({
  id: `bill-${number}`,
  type: "ACCPAY",
  number,
  reference,
  contactId: `contact-${supplier}`,
  contactName: supplier,
  date,
  dueDate: null,
  status: "AUTHORISED",
  subTotal: net,
  totalTax: 0,
  total: net,
  amountDue: net,
  amountPaid: 0,
  amountCredited: 0,
  fullyPaidOn: null,
  cisDeduction: 0,
  lines: [{ description, quantity: 1, unitAmount: net, lineAmount: net, accountCode: "", taxAmount: 0, tracking: [] }],
});

// Bills from the Xero bills tab. The reference holds the job number where the tab shows one.
export const BILLS: XeroInvoice[] = [
  bill("4264", "UNLMTD Electrical & Fire", "2026-09-09", 232, "", "Occupier, Flat 1, 185 New Kings Road, SW6 4SW"),
  bill("LHP3027429", "Lavender Hill Plumbing", "2026-09-11", 56.09, "21239", "Ideal Standard dual flush outlet valve and delivery"),
  bill("LHP1023755", "Lavender Hill Plumbing", "2026-09-11", 63.91, "21242", "Tap cartridges x4, Bristan flow cartridge pair, O-rings x4"),
  bill("LHP3027488", "Lavender Hill Plumbing", "2026-09-14", 21.98, "21260", "WC connector, silicone, blue roll"),
  bill("LHP1023821", "Lavender Hill Plumbing", "2026-09-14", 47.94, "21241", "Ceramic tap cartridges x6"),
  bill("LHP502223", "Lavender Hill Plumbing", "2026-09-14", 472, "", "Pura 55/f wall hung pan and soft close seat"),
  bill("4285", "UNLMTD Electrical & Fire", "2026-09-14", 310, "", "EICR remedial works, Flat 1 185 New Kings Rd SW6, their job 7017"),
  bill("INV-0045", "JN Heating Solutions", "2026-09-15", 342.73, "", "Labour 302.73, materials 40.00"),
  bill("4305", "UNLMTD Electrical & Fire", "2026-09-15", 232, "", "EICR"),
  bill("INV-15938", "JSD Solutions 24/7 Ltd", "2026-09-18", 110, "21165", "1 hr minimum on-site charge, slow-draining sink, Flat 1 55A Ossington St"),
  bill("4441", "Buzzwell Ltd", "2026-09-19", 369.8, "", "Hive thermostat, receiver and hub"),
  bill("PLU-26656", "Plumberoo Ltd", "2026-09-18", 134.38, "", "Not read"),
];

export const SETTINGS: ReportSettings = {
  businessName: "Polkadot",
  syncFrom: "2026-01-01",
  labourShare: 0.45,
  cisRate: 0.2,
  vatRate: 0.2,
  weekEndsOn: 4,
  payRunLagDays: 28,
  projectCategories: ["Refurbishment Works"],
  recallCategories: ["Recall"],
  salesTypeTracking: "Sales Type",
  chaseAfterHours: 48,
  lowMarginPct: 0.15,
};

export function contractorInputs(): ContractorInputs {
  const jobs: SmJob[] = [];
  const lines: SmLine[] = [];
  const invoices: XeroInvoice[] = [...BILLS];
  for (const [completed, who, jobNo, units, rate, parking, materials, other, xeroEx, kind] of JOBS) {
    const uuid = `job-${jobNo}`;
    const chargedEx = r2(units * rate + parking + materials + other);
    jobs.push({
      uuid,
      jobNo,
      status: "Completed",
      active: true,
      date: completed,
      completionDate: completed,
      completedByUuid: staffUuid(who),
      categoryUuid: "cat-sm",
      categoryName: "Standard S&M",
      companyUuid: null,
      customer: `Customer ${jobNo}`,
      customerIsIndividual: true,
      site: "",
      description: "",
      workDone: "",
      totalIncVat: r2(chargedEx * 1.2),
      invoiceSent: true,
      invoiceSentAt: `${completed}T17:00:00Z`,
      quoteSent: false,
      editedAt: null,
    });
    const labourName = kind === "H" ? "Labour per hour" : kind === "F" ? "Fixed price works" : kind;
    const line = (n: number, name: string, quantity: number, price: number): SmLine => ({
      uuid: `${uuid}-l${n}`,
      jobUuid: uuid,
      materialUuid: null,
      name,
      quantity,
      unitPriceEx: price,
      totalEx: r2(quantity * price),
      unitCost: 0,
      sort: n,
    });
    lines.push(line(1, labourName, units, rate));
    if (parking) lines.push(line(2, "Parking", 1, parking));
    if (materials) lines.push(line(3, "Materials and parts", 1, materials));
    if (other) lines.push(line(4, "Other charges", 1, other));
    invoices.push({
      id: `inv-${jobNo}`,
      type: "ACCREC",
      number: jobNo,
      reference: "",
      contactId: `cust-${jobNo}`,
      contactName: `Customer ${jobNo}`,
      date: jobNo === "20941" ? "2026-08-03" : completed,
      dueDate: completed,
      status: "AUTHORISED",
      subTotal: xeroEx,
      totalTax: r2(xeroEx * 0.2),
      total: r2(xeroEx * 1.2),
      amountDue: r2(xeroEx * 1.2),
      amountPaid: 0,
      amountCredited: 0,
      fullyPaidOn: null,
      cisDeduction: 0,
      lines: [],
    });
  }
  const staff: SmStaff[] = CONTRACTORS.map((c) => ({ uuid: staffUuid(c.name), name: c.name, active: true }));
  return {
    settings: SETTINGS,
    contractors: CONTRACTORS,
    fixedFees: FEES,
    deductions: DEDUCTIONS,
    lineRules: [],
    adjustments: ADJUSTMENTS,
    jobs,
    lines,
    activities: [],
    staff,
    invoices,
  };
}
