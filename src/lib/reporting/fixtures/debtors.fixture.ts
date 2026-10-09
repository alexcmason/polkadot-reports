/*
 * The client's debtors chase email of Thu 1 Oct 2026, 12:12 UK time, as ServiceM8 and Xero
 * records. Each EMAIL_ROWS entry is one line of the email: the job, when its invoice went out
 * (chosen so the whole days elapsed match the email), the total, and what was paid where.
 * The last three columns are what the email shows, for the test to check against.
 */
import type { SmJob, SmPayment, XeroInvoice } from "../types";
import type { DebtorChase, DebtorInputs } from "../debtors";

export const DEBTORS_NOW = "2026-10-01T11:12:23Z";
export const DEBTORS_TODAY = "2026-10-01";

// [job, client, site, invoice sent (UTC), total inc VAT, paid, paid in, email: invoiced, days, balance, note]
export type EmailRow = [string, string, string, string, number, number, "xero" | "servicem8" | null, string, number, number, string];

export const EMAIL_ROWS: EmailRow[] = [
  ["20286", "James Allum", "25 Elm Park, , SW2 2TX", "2026-06-11T13:00:00Z", 162, 0, null, "2026-06-11", 111, 162, ""],
  ["20298", "26 Cheyne Row, SW3 5HL", "26 Cheyne Row, London SW3 5HL, UK", "2026-06-15T13:00:00Z", 161.4, 0, null, "2026-06-15", 107, 161.4, ""],
  ["20244B", "Kerry Freire", "18 Lavender Gardens London SW11 1DL", "2026-06-18T13:00:00Z", 2667.64, 0, null, "2026-06-18", 104, 2667.64, ""],
  ["20074", "Romain Demory", "8 Beltran RdLondon SW6 3AJ, UK", "2026-06-24T08:00:00Z", 633.3, 0, null, "2026-06-24", 99, 633.3, ""],
  ["20440", "Flat 407, Bankside Lofts, 65 Hopton Street", "407, 65 Hopton St, London SE1 9JL, UK", "2026-06-24T08:07:00Z", 165, 0, null, "2026-06-24", 99, 165, ""],
  ["20238", "48 Harley House, NW1 5HL", "48 Harley House, NW1 5HL", "2026-06-24T08:14:00Z", 369.5, 275.75, "xero", "2026-06-24", 99, 93.75, "Part-paid via Xero"],
  ["20441", "7 Albion Street, W2 2AS", "7 Albion St, St George's Fields, London W2 2A", "2026-06-24T13:21:00Z", 281.4, 0, null, "2026-06-24", 98, 281.4, ""],
  ["20302", "71 Harley House", "71 Harley House, NW1 5HL", "2026-06-25T08:00:00Z", 560.5, 504.25, "xero", "2026-06-25", 98, 56.25, "Part-paid via Xero"],
  ["20439", "2B Beau House, Pond Place, SW3 6QJ", "2B Beau House, Pond Place, SW3 6QJ", "2026-06-26T13:00:00Z", 251.4, 0, null, "2026-06-26", 96, 251.4, ""],
  ["20436", "Chelsea Bridge Wharf Car Wash", "Chelsea Bridge Wharf Car Wash", "2026-06-30T08:00:00Z", 300, 0, null, "2026-06-30", 93, 300, ""],
  ["20558", "Ian Pannell", "64 Narbonne Avenue, , SW4 9JT", "2026-06-30T13:07:00Z", 300, 0, null, "2026-06-30", 92, 300, ""],
  ["20627", "Will Callander", "105A Ravenslea Road, , SW12 8LQ", "2026-07-03T13:00:00Z", 2241.92, 0, null, "2026-07-03", 89, 2241.92, ""],
  ["20732", "26 Cheyne Row, SW3 5HL", "26 Cheyne Row, London SW3 5HL, UK", "2026-07-07T08:00:00Z", 150, 0, null, "2026-07-07", 86, 150, ""],
  ["20731", "52 Argyll Road", "52 Argyll Rd, London W8 7BS, UK", "2026-07-07T08:07:00Z", 125, 87.5, "xero", "2026-07-07", 86, 37.5, "Part-paid via Xero"],
  ["20402", "Saffronland Homes", "29 Fenwick Road London SE15 4HS", "2026-07-08T13:00:00Z", 600.24, 0, null, "2026-07-08", 84, 600.24, ""],
  ["20755", "Sophie Toy", "37 Fairmount Road, , SW2 2BJ", "2026-07-08T13:07:00Z", 150, 0, null, "2026-07-08", 84, 150, ""],
  ["20759", "Anna Kinnersley", "31 Dalkeith Rd Norwood, London SE21 8LT", "2026-07-10T08:00:00Z", 308.39, 158.39, "servicem8", "2026-07-10", 83, 150, "Part-paid via ServiceM8 Pay"],
  ["20784", "Mara Bruno", "117 Neckinger Estate, SE16 3QG", "2026-07-15T08:00:00Z", 170.4, 150, "servicem8", "2026-07-15", 78, 20.4, "Part-paid via ServiceM8 Pay"],
  ["20801", "6 Egbert Street", "6 Egbert St, London NW1 8LJ, UK", "2026-07-15T08:07:00Z", 204, 0, null, "2026-07-15", 78, 204, ""],
  ["20550", "95 Peterborough Road", "95 Peterborough Rd, London SW6 3BU, UK", "2026-07-15T08:14:00Z", 282, 0, null, "2026-07-15", 78, 282, ""],
  ["20814", "Penthouse 4, Harley House", "Penthouse 4, Harley House, London NW1 5HL, UK", "2026-07-16T13:00:00Z", 575.54, 519.29, "xero", "2026-07-16", 76, 56.25, "Part-paid via Xero"],
  ["20443", "41 Kensington House", "41 Kensington House, SW11 4FA", "2026-07-22T08:00:00Z", 720, 0, null, "2026-07-22", 71, 720, ""],
  ["20379", "Unit 1, Rushworth Studios, 63 Webber Street", "1, Rushworth Studios, 63 Webber St, London SE", "2026-07-22T08:07:00Z", 432, 0, null, "2026-07-22", 71, 432, ""],
  ["20694", "4 Kensington House", "4 Kensington House, SW11 4FA", "2026-07-22T08:14:00Z", 432, 0, null, "2026-07-22", 71, 432, ""],
  ["20862", "Flat 2, 14 Killieser Avenue", "2, 14 Killieser Ave, London SW2 4NT, UK", "2026-07-22T13:21:00Z", 432, 0, null, "2026-07-22", 70, 432, ""],
  ["20884", "Callahan Hager", "56 Fairfield Drive , SW18 1DN", "2026-07-28T08:00:00Z", 369.07, 0, null, "2026-07-28", 65, 369.07, ""],
  ["20900", "Flat 2, 23 Kellet Road", "Flat 2, 23 Kellett Rd, London SW2 1DX, UK", "2026-07-29T08:00:00Z", 210, 0, null, "2026-07-29", 64, 210, ""],
  ["20890", "Edward Reed", "28 Chantrey Road, , SW9 9TE", "2026-07-31T08:00:00Z", 333.6, 0, null, "2026-07-31", 62, 333.6, ""],
  ["20889", "Edward Reed", "28 Chantrey Road, , SW9 9TE", "2026-07-31T08:07:00Z", 268.8, 0, null, "2026-07-31", 62, 268.8, ""],
  ["20921", "103 Ravensbury Road SW184RY", "103 Ravensbury Road SW184RY", "2026-07-31T13:14:00Z", 432, 0, null, "2026-07-31", 61, 432, ""],
  ["20912", "7B Oseney Crescent London NW5 2AT", "7B Oseney Cres, London NW5 2AT, UK", "2026-08-01T08:00:00Z", 198, 0, null, "2026-08-01", 61, 198, ""],
  ["20907", "Paula Clarke", "70 Alma Rd. London SW18 1AH, UK", "2026-08-03T13:00:00Z", 776.88, 0, null, "2026-08-03", 58, 776.88, ""],
  ["20932", "33 Bramford Road, SW18 1A P", "33 Bramford Rd, London SW18 1AP, UK", "2026-08-03T13:07:00Z", 225.6, 0, null, "2026-08-03", 58, 225.6, ""],
  ["20885", "Michael Vale", "83 Tudor Close, Brixton Hill, London, SW2 2AD", "2026-08-05T08:00:00Z", 198, 0, null, "2026-08-05", 57, 198, ""],
  ["20969A", "Nadine Teychenne", "198 Castelaine Mansions, W9 1HD", "2026-08-05T08:07:00Z", 1410.31, 0, null, "2026-08-05", 57, 1410.31, ""],
  ["20956", "Paula Clarke", "70 Alma Rd. London SW18 1AH, UK", "2026-08-07T13:00:00Z", 225, 0, null, "2026-08-07", 54, 225, ""],
  ["20630", "Michael Vale", "83 Tudor Close, Brixton Hill, London, SW2 2AD", "2026-08-10T13:00:00Z", 198, 0, null, "2026-08-10", 51, 198, ""],
  ["21031", "Flat 44, Gallery Loft, 69 Hopton Street", "69 Hopton St, London SE1 9LF, UK", "2026-08-18T08:00:00Z", 258, 0, null, "2026-08-18", 44, 258, ""],
  ["21055", "James Sellar", "19 Carlton Hill, London NW8 0JX, UK", "2026-08-18T13:07:00Z", 523.2, 0, null, "2026-08-18", 43, 523.2, ""],
  ["21054", "Flat 10, 47 Grosvenor Square", "10, 47 Grosvenor Sq, London W1K 2HS, UK", "2026-08-18T13:14:00Z", 249, 0, null, "2026-08-18", 43, 249, ""],
  ["21077", "Susan Cronin", "44 Argento Tower Mapleton Road, SW18 4GA", "2026-08-20T08:00:00Z", 150, 0, null, "2026-08-20", 42, 150, ""],
  ["21083", "The Britannia", "44 Kipling St, London SE1 3RU, UK", "2026-08-20T13:07:00Z", 534.96, 0, null, "2026-08-20", 41, 534.96, ""],
  ["21078", "Margaret Novakovic", "52 Beechdale Road , SW2 2BE", "2026-08-20T13:14:00Z", 542.4, 0, null, "2026-08-20", 41, 542.4, ""],
  ["21011", "Jemima Middle", "37b Lynette Avenue , SW4 9HE", "2026-08-21T08:00:00Z", 150, 0, null, "2026-08-21", 41, 150, ""],
  ["20868", "George and Sarah Clegg Littler", "20 Oakley Gardens, , SW3 5QG", "2026-08-21T13:07:00Z", 2746.82, 0, null, "2026-08-21", 40, 2746.82, ""],
  ["21090", "Annabelle Fry", "2, Dolphin House, SW6 2GY", "2026-08-21T13:14:00Z", 348.72, 0, null, "2026-08-21", 40, 348.72, ""],
  ["10", "33 Sussex Lodge, Sussex Place, W2 2SQ", "Sussex Lodge, 22 Sussex Pl, Tyburnia, London", "2026-09-03T13:00:00Z", 3420, 0, null, "2026-09-03", 27, 3420, ""],
  ["20969", "Nadine Teychenne", "198 Castelaine Mansions, W9 1HD", "2026-09-03T13:07:00Z", 173.94, 0, null, "2026-09-03", 27, 173.94, ""],
  ["20976", "12 Dorset Mansions", "12 Dorset Mansions, SW6 7PF", "2026-09-03T13:14:00Z", 150, 0, null, "2026-09-03", 27, 150, ""],
  ["21143", "Matthew Ramsbotham", "Flat 4, 170 Tachbrook Street, , SW1V 2NE", "2026-09-07T13:00:00Z", 163.69, 0, null, "2026-09-07", 23, 163.69, ""],
  ["21170", "Sinclair Gardens Ltd", "Flat 4, 3 Sinclair Gardens, London W14 0AU, U", "2026-09-08T13:00:00Z", 516, 0, null, "2026-09-08", 22, 516, ""],
  ["20437", "Viridian Apartments", "Viridian Apartments, Battersea Park Road, SW8", "2026-09-08T13:07:00Z", 3960, 0, null, "2026-09-08", 22, 3960, ""],
  ["20356", "Simon Kellett", "52 Strathbrook Rd , SW16 3AZ", "2026-09-10T13:00:00Z", 17482.89, 10000, "xero", "2026-09-10", 20, 7482.89, "Part-paid via Xero"],
  ["21242", "29 Criffle Avenue", "29 Criffel Ave, London SW2 4AY, UK", "2026-09-11T13:00:00Z", 612, 0, null, "2026-09-11", 19, 612, ""],
  ["21151", "Alan Froome", "67 Tudor Close, Brixton Hill, London, SW2 2AB", "2026-09-14T08:00:00Z", 150, 0, null, "2026-09-14", 17, 150, ""],
  ["21260", "Jimmy Garcia Catering", "6-7 River Reach, 1 Gartons Way, SW11 3SX", "2026-09-15T08:00:00Z", 351.6, 0, null, "2026-09-15", 16, 351.6, ""],
  ["21275", "Jess Lindvall", "Ground Floor, 12 Lisgar Terrace , W14 8SJ", "2026-09-15T13:07:00Z", 333.6, 0, null, "2026-09-15", 15, 333.6, ""],
  ["21269", "unit 8 rosemary road", "8 Rosemary Rd, London SW17 0AR, UK", "2026-09-16T08:00:00Z", 150, 0, null, "2026-09-16", 15, 150, ""],
  ["21220", "46 Abercrombie St", "46 Abercrombie St, London SW11 2JD, UK", "2026-09-16T13:07:00Z", 398.83, 0, null, "2026-09-16", 14, 398.83, ""],
  ["21280", "78 Park Court", "Flat 78 Park Court, 191 Battersea Park Road,", "2026-09-17T08:00:00Z", 325.37, 0, null, "2026-09-17", 14, 325.37, ""],
  ["21240", "Alan Froome", "67 Tudor Close, Brixton Hill, London, SW2 2AB", "2026-09-18T08:00:00Z", 900, 0, null, "2026-09-18", 13, 900, ""],
  ["21245", "19 Tooting Bec Gardens", "19 Tooting Bec Gardens, London SW16 1QY, UK", "2026-09-18T08:07:00Z", 129.6, 0, null, "2026-09-18", 13, 129.6, ""],
  ["21262", "Sally Quick", "23c Helix Gardens, , SW2 2JJ", "2026-09-18T13:14:00Z", 261, 0, null, "2026-09-18", 12, 261, ""],
  ["21256", "Flat B, 36 Evelyn Gardens, South Kensington", "Flat B, 36 Evelyn Gardens, South Kensington,", "2026-09-18T13:21:00Z", 600, 0, null, "2026-09-18", 12, 600, ""],
  ["21299", "Townhouse 1, 13 Leinster Square", "Townhouse 1, 13 Leinster Square, London W2 4P", "2026-09-18T13:28:00Z", 167.26, 0, null, "2026-09-18", 12, 167.26, ""],
  ["21296", "Flat B, 36 Evelyn Gardens, South Kensington", "Flat B, 36 Evelyn Gardens, South Kensington,", "2026-09-18T13:35:00Z", 159.6, 0, null, "2026-09-18", 12, 159.6, ""],
  ["20833", "Susanne Graepel", "Flat 2, 62 Cumberland Street, , SW1V 4LZ", "2026-09-21T13:00:00Z", 733.34, 0, null, "2026-09-21", 9, 733.34, ""],
  ["21321", "Susanne Graepel", "Flat 2, 62 Cumberland Street, , SW1V 4LZ", "2026-09-21T13:07:00Z", 1500, 0, null, "2026-09-21", 9, 1500, ""],
  ["21297", "Daniel Fenn", "139 Boundaries Road, , SW12 8HD", "2026-09-22T13:00:00Z", 154.5, 0, null, "2026-09-22", 8, 154.5, "Paid by card 22 Sep per Stripe – mark paid, do not chase"],
  ["21106C", "Inessa Taylor", "9 Ivymount Rd, Norwood, London SE27 0NB, UK", "2026-09-23T13:00:00Z", 10000, 0, null, "2026-09-23", 7, 10000, ""],
  ["21298", "17 Tregunter Road", "17 Tregunter Rd, London SW10 9LS, UK", "2026-09-24T13:00:00Z", 346.06, 0, null, "2026-09-24", 6, 346.06, ""],
  ["21348", "10 Chelsea Park Gardens, SW3 6AA", "10 Chelsea Park Gardens, London SW3 6AA, UK", "2026-09-24T13:07:00Z", 150, 0, null, "2026-09-24", 6, 150, ""],
  ["21319", "Izzy Watson", "51a Endymion Road, , SW2 2BU", "2026-09-25T08:00:00Z", 252, 0, null, "2026-09-25", 6, 252, ""],
  ["21276", "Rosanna Masojada", "Hartlea House, High Drive, , CR3 7EL", "2026-09-25T13:07:00Z", 300, 0, null, "2026-09-25", 5, 300, ""],
  ["21340", "21d Sheffield Terrace", "21 Sheffield Terrace, London W8 7NQ, UK", "2026-09-25T13:14:00Z", 445.2, 0, null, "2026-09-25", 5, 445.2, ""],
];

export const EMAIL_TOTALS = { count: 75, amount: 55615.29 };

// [label, invoices, outstanding]
export const EMAIL_BUCKETS: [string, number, number][] = [
  ["Under 30 days", 29, 34286.48],
  ["30–59 days", 15, 8536.89],
  ["60–89 days", 20, 7719.78],
  ["90+ days", 11, 5072.14],
];

export const CHASES: DebtorChase[] = [
  { jobNo: "21297", status: "paid", note: "Paid by card 22 Sep per Stripe – mark paid, do not chase", lastChasedOn: null, chaseCount: 0 },
];

export function smJob(jobNo: string, customer: string, site: string, sentAt: string | null, total: number): SmJob {
  return {
    uuid: `job-${jobNo}`,
    jobNo,
    status: "Completed",
    active: true,
    date: sentAt ? sentAt.slice(0, 10) : null,
    completionDate: sentAt ? sentAt.slice(0, 10) : null,
    completedByUuid: null,
    categoryUuid: null,
    categoryName: "",
    companyUuid: null,
    customer,
    customerIsIndividual: null,
    site,
    description: "",
    workDone: "",
    totalIncVat: total,
    invoiceSent: sentAt !== null,
    invoiceSentAt: sentAt,
    quoteSent: false,
    editedAt: null,
  };
}

export function salesInvoice(number: string, contactName: string, date: string, total: number, paid: number, dueDate: string | null = date): XeroInvoice {
  const subTotal = Math.round((total / 1.2) * 100) / 100;
  return {
    id: `inv-${number}`,
    type: "ACCREC",
    number,
    reference: "",
    contactId: `contact-${contactName}`,
    contactName,
    date,
    dueDate,
    status: paid >= total ? "PAID" : "AUTHORISED",
    subTotal,
    totalTax: Math.round((total - subTotal) * 100) / 100,
    total,
    amountDue: Math.round((total - paid) * 100) / 100,
    amountPaid: paid,
    amountCredited: 0,
    fullyPaidOn: paid >= total ? date : null,
    cisDeduction: 0,
    lines: [],
  };
}

export function debtorsInputs(): DebtorInputs {
  const jobs: SmJob[] = [];
  const payments: SmPayment[] = [];
  const invoices: XeroInvoice[] = [];
  for (const [jobNo, customer, site, sentAt, total, paid, paidIn] of EMAIL_ROWS) {
    jobs.push(smJob(jobNo, customer, site, sentAt, total));
    invoices.push(salesInvoice(jobNo, customer, sentAt.slice(0, 10), total, paidIn === "xero" ? paid : 0));
    if (paidIn === "servicem8") {
      payments.push({ uuid: `pay-${jobNo}`, jobUuid: `job-${jobNo}`, amount: paid, date: sentAt.slice(0, 10), method: "ServiceM8 Pay", note: "", isDeposit: false });
    }
  }
  // Records that are not debtors: paid in full in ServiceM8, not invoiced, deleted, nil total.
  jobs.push(smJob("21001", "Paid Up", "1 High St, SW1A 1AA", "2026-09-01T09:00:00Z", 300));
  payments.push({ uuid: "pay-21001", jobUuid: "job-21001", amount: 300, date: "2026-09-02", method: "Card", note: "", isDeposit: false });
  jobs.push(smJob("21002", "Not Invoiced", "2 High St, SW1A 1AA", null, 450));
  jobs.push({ ...smJob("21003", "Deleted Job", "3 High St, SW1A 1AA", "2026-08-01T09:00:00Z", 600), active: false });
  jobs.push(smJob("21004", "Nil Total", "4 High St, SW1A 1AA", "2026-08-01T09:00:00Z", 0));
  return { jobs, payments, invoices, chases: CHASES, chaseAfterHours: 48, now: DEBTORS_NOW, today: DEBTORS_TODAY };
}
