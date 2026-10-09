/*
 * The client's projects spreadsheet (EE Building Services projects, prepared 5 Oct 2026),
 * as ServiceM8 and Xero records. Each PROJECTS entry is one row of the sheet; the jobs,
 * lines, deposits, sales invoices and EE's bills (domestic reverse charge, so no VAT) are
 * the facts behind it. The engine works the figures out from these.
 */
import type { SmJob, SmLine, SmPayment, XeroInvoice } from "../types";
import type { ProjectCost, ProjectInputs, ProjectRecord, ProjectStatus } from "../projects";

export const PROJECTS_TODAY = "2026-10-05";
export const EE = "EE Building Supplies";

const RE = "Refurbishment Works";
const SM = "Service & Maintenance (S&M)";
const NONE = "";

// [id, customer, site, works, status, job numbers, EE estimate no, EE quoted, goodwill]
type ProjectSpec = [string, string, string, string, ProjectStatus, string[], string, number | null, boolean?];

export const PROJECTS: ProjectSpec[] = [
  ["kellett", "Simon Kellett", "52 Strathbrook Rd, SW16 3AZ", "Full bathroom renovation + utility cupboard", "completed", ["20356", "20820"], "18233", 9200],
  ["ward", "Mike Ward", "89 Hazelbourne Rd, SW12 9NT", "Bathroom works + extras (mirror, grout, trims)", "completed", ["20605", "21155"], "18234", 1350],
  ["graepel", "Susanne Graepel", "Flat 2, 62 Cumberland St, SW1V 4LZ", "Woodwork, radiator, bathroom works (insurance claim)", "completed", ["21321"], "18238", 1050],
  ["fane", "Nicola Fane", "46 The Chase, SW4 0NH", "Shower valve replacement", "completed", ["20718"], "18241", 550],
  ["corbett", "Jane Corbett", "52 Lillieshall Rd, SW4 0LP", "Remove steel worktop cladding", "completed", ["21157"], "18243", 200, true],
  ["morton", "Christina Morton", "8 Pymers Mead, SE21 8NQ", "Shower pump, mixers, metro tiles", "completed", ["20762A"], "", null],
  ["maxel", "Maxel Projects Ltd", "33 Sussex Lodge, Sussex Pl, W2 2SQ", "Shower cubicle strip-out and reseal", "completed", ["10"], "", null],
  ["lonie", "Chris Lonie", "66 Rathmell Drive, SW4 8JW", "Full bathroom refurbishment", "in_progress", ["20290A", "20290"], "18242", 8200],
  ["knollys-floor", "Patrick Knollys", "83 Littleton St, SW18 3SZ", "Kitchen floor repair + waterproof membrane", "in_progress", ["20803", "21156"], "18235", 2250],
  ["knollys-ceiling", "Patrick Knollys", "83 Littleton St, SW18 3SZ", "Ceiling wallpaper removal, patch, paint", "in_progress", ["21064"], "18244", 1800],
  ["holmes", "Eleanor Holmes", "55B Herne Hill Rd, SE24 0AX", "Bathroom works (bath, panel, mixer, vinyl)", "in_progress", ["20529"], "18236", 3650],
  ["akdemir", "Basak Akdemir", "25 Blore House, Coleridge Gdns, SW10 0RB", "Decorating and general repairs", "in_progress", ["21130"], "18248", 2500],
  ["maclay", "Matt Maclay", "673 Wandsworth Rd, SW8 3JE", "Ceiling repair and downlight", "in_progress", ["21317"], "18246", 850],
  ["mason", "Matthew Mason", "26 Ravensdon St, SE11 4AR", "Full bathroom refurbishment", "quoted", ["21300"], "18249", 15200],
  ["shivarova", "Ekaterina Shivarova", "Flat B, 40 Craster Rd, SW2 2AU", "Bathroom refurbishment", "quoted", ["21109"], "18245", 8700],
  ["clarke", "Paula Clarke", "70 Alma Rd, SW18 1AH", "Leak repair works (ceiling, hallway, bathrooms)", "quoted", ["21124"], "18246", 6200],
  ["carson", "Jan Carson", "63B Grace's Rd, SE5 8PF", "Toilet, basin, tap, washing machine, cold feed", "quoted", ["21271"], "18247", 2200],
  ["jopling", "Caroline Jopling", "Flat 2, Turnmill House, Effra Parade, SW2 1QA", "Bathroom upgrade", "awaiting_price", ["21359"], "", null],
  ["semple", "Andrew Semple", "Flat 11, 61 Cadogan Gardens, SW3 2RA", "Plasterboard over lath in eaves cupboard and paint", "awaiting_price", ["21301"], "", null],
  ["bain", "Tiffany Bain", "109 Helix Rd, SW2 2JR", "Shower reseal and regrout", "lost", ["20809"], "18239", 550],
  ["neave", "Alice Neave", "Flat 2, 32 Rita Rd, SW8 1JU", "Ceiling repair after leak", "lost", ["20902"], "18240", 850],
];

// [job no, customer, ServiceM8 status, category, lines [name, ex VAT], total inc VAT, invoice sent (UTC) or null, payments [date, amount]]
type JobSpec = [string, string, string, string, [string, number][], number, string | null, [string, number][]?];

export const JOBS: JobSpec[] = [
  ["20356", "Simon Kellett", "Completed", RE, [["Bathroom renovation", 14519], ["Building control fee (no VAT)", 60.09]], 17482.89, "2026-09-10T09:30:00Z"],
  ["20820", "Simon Kellett", "Completed", NONE, [["Utility cupboard", 705]], 846, "2026-07-28T10:00:00Z", [["2026-07-20", 846]]],
  ["20605", "Mike Ward", "Completed", RE, [["Bathroom works", 1755]], 2106, "2026-08-28T14:00:00Z"],
  ["21155", "Mike Ward", "Completed", NONE, [["Mirror, grout and trims", 475.98]], 571.18, "2026-09-12T09:00:00Z"],
  ["21321", "Susanne Graepel", "Completed", RE, [["Woodwork, radiator and bathroom works", 1250]], 1500, "2026-09-21T10:00:00Z"],
  // Card payment in ServiceM8 as well as in Xero: counted once.
  ["20718", "Nicola Fane", "Completed", RE, [["Shower valve replacement", 1535]], 1842, "2026-08-20T11:00:00Z", [["2026-08-22", 1842]]],
  ["21157", "Jane Corbett", "Completed", RE, [["Remove steel worktop cladding", 300]], 360, null],
  ["20762A", "Christina Morton", "Completed", NONE, [["Shower pump, mixers and metro tiles", 2440]], 2928, "2026-07-14T09:00:00Z"],
  ["10", "Maxel Projects Ltd", "Completed", NONE, [["Shower cubicle strip-out and reseal", 2850]], 3420, "2026-09-03T09:00:00Z"],
  ["20290A", "Chris Lonie", "Completed", RE, [["Stage invoice – 90% complete", 11345]], 13614, "2026-09-11T09:00:00Z"],
  ["20290", "Chris Lonie", "Work Order", RE, [["Full bathroom refurbishment", 12605], ["Less stage invoice 20290A", -11345]], 1512, "2026-10-02T09:00:00Z"],
  ["20803", "Patrick Knollys", "Work Order", RE, [["Kitchen floor repair", 2725]], 3270, null],
  ["21156", "Patrick Knollys", "Work Order", RE, [["Waterproof membrane", 200]], 240, null],
  ["21064", "Patrick Knollys", "Work Order", RE, [["Ceiling wallpaper removal, patch and paint", 2570]], 3084, null],
  ["20529", "Eleanor Holmes", "Work Order", NONE, [["Bathroom works – bath, panel, mixer, vinyl", 3756.27]], 4507.52, null],
  ["21130", "Basak Akdemir", "Work Order", RE, [["Decorating and general repairs", 3900]], 4680, null, [["2026-10-01", 4680]]],
  ["21317", "Matt Maclay", "Work Order", SM, [["Ceiling repair and downlight", 1215]], 1458, null, [["2026-10-01", 1458]]],
  ["21300", "Matthew Mason", "Quote", RE, [["Full bathroom refurbishment", 19760]], 23712, null],
  ["21109", "Ekaterina Shivarova", "Quote", NONE, [["Bathroom refurbishment", 11310]], 13572, null],
  ["21124", "Paula Clarke", "Quote", RE, [["Leak repair works", 8200]], 9840, null],
  ["21271", "Jan Carson", "Quote", RE, [["Toilet, basin, tap, washing machine, cold feed", 3432]], 4118.4, null],
  ["21359", "Caroline Jopling", "Quote", RE, [], 0, null],
  ["21301", "Andrew Semple", "Quote", RE, [], 0, null],
  ["20809", "Tiffany Bain", "Unsuccessful", RE, [["Shower reseal and regrout", 715]], 858, null],
  ["20902", "Alice Neave", "Unsuccessful", RE, [["Ceiling repair after leak", 1150]], 1380, null],
  // Not part of any project.
  ["20833", "Susanne Graepel", "Completed", SM, [["Sink pipework", 611.12]], 733.34, "2026-09-21T10:05:00Z"],
];

// [number, contact, date, ex VAT, inc VAT, paid, status]
type SaleSpec = [string, string, string, number, number, number, string?];

export const SALES: SaleSpec[] = [
  ["20356", "Simon Kellett", "2026-09-10", 14579.09, 17482.89, 10000],
  ["20605", "Mike Ward", "2026-08-28", 1755, 2106, 2106],
  ["21155", "Mike Ward", "2026-09-12", 475.98, 571.18, 571.18],
  ["21321", "Susanne Graepel", "2026-09-21", 1250, 1500, 1500],
  ["20718", "Nicola Fane", "2026-08-20", 1535, 1842, 1842],
  ["20718", "Nicola Fane", "2026-08-19", 1535, 1842, 0, "VOIDED"],
  ["20762A", "Christina Morton", "2026-07-14", 2440, 2928, 0],
  ["10", "Maxel Projects Ltd", "2026-09-03", 2850, 3420, 0],
  ["20290A", "Chris Lonie", "2026-09-11", 11345, 13614, 8000],
  ["20290", "Chris Lonie", "2026-10-02", 1260, 1512, 0],
  ["20290B", "Chris Lonie", "2026-10-04", 500, 600, 0, "DRAFT"],
  // Other jobs whose numbers start the same way: not this project's.
  ["202901", "Someone Else", "2026-09-01", 100, 120, 0],
  ["20356AB", "Someone Else", "2026-09-01", 100, 120, 0],
  ["20833", "Susanne Graepel", "2026-09-21", 611.12, 733.34, 733.34],
];

// [number, date, amount, paid, description, reference, contact, status]
type BillSpec = [string, string, number, number, string, string?, string?, string?];

export const BILLS: BillSpec[] = [
  ["0227", "2026-07-10", 1100, 1100, "Shower pump, mixers, metro tiles"],
  ["0228", "2026-08-22", 550, 550, "Labour"],
  ["0229", "2026-08-28", 1350, 1350, "Bathroom works"],
  ["0230", "2026-09-01", 1050, 0, "Bathroom works"],
  ["0231", "2026-08-22", 1950, 1950, "Labour"],
  ["0234", "2026-09-02", 1050, 0, "Shower cubicle strip-out and reseal"],
  ["0235", "2026-09-15", 332.86, 0, "Extras – mirror, grout, trims"],
  ["0236", "2026-09-09", 7380, 7380, "Bathroom works 90% of estimate"],
  ["0237", "2026-09-20", 9300, 0, "Full bathroom renovation"],
  ["0238", "2026-09-20", 330, 0, "Extras"],
  ["0239", "2026-09-25", 200, 0, "Remove steel cladding from worktop"],
  ["0240", "2026-10-02", 3650, 0, "Remove steel cladding from worktop"],
  ["0241", "2026-10-02", 820, 0, "Bathroom works final 10%"],
  ["0242", "2026-10-02", 2250, 0, "Flooring"],
  // Not yet on any project.
  ["0243", "2026-10-03", 480, 0, "Making good", "Plastering"],
  ["0233", "2026-09-01", 999, 0, "Entered twice", "", EE, "VOIDED"],
  ["wink246", "2026-08-19", 1050, 1050, "66 Rathmell Drive, SW4 8JW", "", "DJB Independent Plumbing & Heating"],
];

// [project id, EE bill number, tie]
type CostSpec = [string, string, ("tied" | "probable")?];

export const COSTS: CostSpec[] = [
  ["kellett", "0237"],
  ["kellett", "0238"],
  ["ward", "0229"],
  ["ward", "0235"],
  ["graepel", "0230"],
  ["graepel", "0231"],
  ["fane", "0228"],
  ["corbett", "0239"],
  ["morton", "0227"],
  ["maxel", "0234"],
  ["lonie", "0236", "probable"],
  ["lonie", "0241"],
  ["knollys-floor", "0242"],
  ["holmes", "0240"],
];

const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function projectsInputs(): ProjectInputs {
  const projects: ProjectRecord[] = PROJECTS.map(([id, customer, site, works, status, jobNumbers, est, quoted, goodwill]) => ({
    id,
    customer,
    site,
    works,
    salesType: "RE",
    status,
    jobNumbers,
    subcontractor: "EE Building Services",
    subSupplier: EE,
    subEstimateNo: est,
    subQuoted: quoted,
    subCostOverride: null,
    priceOverride: null,
    goodwill: goodwill ?? false,
    notes: "",
  }));

  const jobs: SmJob[] = [];
  const lines: SmLine[] = [];
  const payments: SmPayment[] = [];
  for (const [jobNo, customer, status, category, jobLines, total, sentAt, paid] of JOBS) {
    const uuid = `job-${jobNo}`;
    const site = projects.find((p) => p.jobNumbers.includes(jobNo))?.site ?? "";
    jobs.push({
      uuid,
      jobNo,
      status,
      active: true,
      date: "2026-07-01",
      completionDate: status === "Completed" ? dateOf(sentAt) : null,
      completedByUuid: null,
      categoryUuid: category ? `cat-${category}` : null,
      categoryName: category,
      companyUuid: `co-${customer}`,
      customer,
      customerIsIndividual: !customer.endsWith("Ltd"),
      site,
      description: jobLines[0]?.[0] ?? "",
      workDone: "",
      totalIncVat: total,
      invoiceSent: sentAt !== null,
      invoiceSentAt: sentAt,
      quoteSent: status === "Quote",
      editedAt: null,
    });
    jobLines.forEach(([name, ex], i) =>
      lines.push({ uuid: `${uuid}-l${i}`, jobUuid: uuid, materialUuid: null, name, quantity: 1, unitPriceEx: ex, totalEx: ex, unitCost: 0, sort: i })
    );
    (paid ?? []).forEach(([date, amount], i) =>
      payments.push({ uuid: `${uuid}-p${i}`, jobUuid: uuid, amount, date, method: "Card", note: "", isDeposit: !sentAt || date < sentAt.slice(0, 10) })
    );
  }
  // A deleted job with the same number as a live one is ignored.
  jobs.push({ ...jobs.find((j) => j.jobNo === "21130")!, uuid: "job-21130-deleted", active: false, categoryName: SM });

  const sales: XeroInvoice[] = SALES.map(([number, contact, date, ex, inc, paid, status], i) => ({
    id: `sale-${number}-${i}`,
    type: "ACCREC",
    number,
    reference: "",
    contactId: `contact-${contact}`,
    contactName: contact,
    date,
    dueDate: date,
    status: status ?? (paid >= inc ? "PAID" : "AUTHORISED"),
    subTotal: ex,
    totalTax: Math.round((inc - ex) * 100) / 100,
    total: inc,
    amountDue: Math.round((inc - paid) * 100) / 100,
    amountPaid: paid,
    amountCredited: 0,
    fullyPaidOn: paid >= inc ? date : null,
    cisDeduction: 0,
    lines: [],
  }));

  const bills: XeroInvoice[] = BILLS.map(([number, date, amount, paid, description, reference, contact, status]) => ({
    id: `bill-${number}`,
    type: "ACCPAY",
    number,
    reference: reference ?? "",
    contactId: `contact-${contact ?? EE}`,
    contactName: contact ?? EE,
    date,
    dueDate: date,
    status: status ?? (paid >= amount ? "PAID" : "AUTHORISED"),
    subTotal: amount,
    totalTax: 0,
    total: amount,
    amountDue: amount - paid,
    // 0231 was settled by a credit note.
    amountPaid: number === "0231" ? 0 : paid,
    amountCredited: number === "0231" ? paid : 0,
    fullyPaidOn: paid >= amount ? date : null,
    cisDeduction: 0,
    lines: [{ description, quantity: 1, unitAmount: amount, lineAmount: amount, accountCode: "320", taxAmount: 0, tracking: [] }],
  }));

  const costs: ProjectCost[] = COSTS.map(([projectId, number, tie]) => {
    const bill = bills.find((b) => b.number === number)!;
    return {
      id: `cost-${number}`,
      projectId,
      xeroInvoiceId: bill.id,
      supplier: bill.contactName,
      ref: bill.number,
      date: bill.date,
      description: bill.lines[0].description,
      amount: bill.total,
      tie: tie ?? "tied",
      isSub: true,
    };
  });

  return {
    projects,
    costs,
    jobs,
    lines,
    payments,
    invoices: [...sales, ...bills],
    settings: { vatRate: 0.2, projectCategories: [RE], lowMarginPct: 0.15 },
    today: PROJECTS_TODAY,
  };
}
