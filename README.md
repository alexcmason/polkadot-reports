# Polkadot Reports

A private web app that reads Polkadot's ServiceM8 and Xero and turns them into the four reports they used to build by hand:

- **Contractors.** The weekly contractor report and the month master: what each job charged, what the contractor costs, CIS, money paid back, weekly deductions, net pay and gross margin. Weeks run Friday to Thursday and pay runs four weeks later, both changeable.
- **Projects.** Refurbishment and installation work, held out of the contractor figures: subcontractor price, our price, billing, payments and margin per project.
- **Debtors.** Invoices sent from ServiceM8 and still unpaid after 48 hours, checked against Xero, aged and ready to chase, with a status and note on each.
- **Management accounts.** The month's profit and loss from Xero, split by the Sales Type tracking category, with the year to date, the balance sheet, invoices raised in the month and contractor profitability.

Every report downloads as an Excel workbook laid out like the spreadsheet it replaces. Questions for Polkadot go on the **Questions** tab, and they answer them when they sign in.

It is a standalone app with its own logins and database. Nothing is shared with any other system. It only reads ServiceM8 and Xero, and never changes anything in them.

Built with Next.js and Postgres. Designed to run on Vercel.

## What has and has not been tested

Checked against Polkadot's own spreadsheets, to the penny, by the automated tests (`npm test`, 113 tests):

- The weekly contractor report and month master: the September 2026 master workbook, 68 jobs, £21,920.23 charged, £10,114.50 net pay, £1,722.13 CIS.
- The projects margin tracker: 21 projects, £95,263.34 price, £26,500.48 gross profit.
- The debtors chase list: 75 invoices, £55,615.29, as in the 1 October email.
- The September 2026 profit and loss figures in the management accounts.

Tested in a real browser against a real Postgres database, with the demonstration data:

- First-time setup, sign in, sign out, lockout after 8 failed attempts in 15 minutes.
- Every report page and every Excel download, adjusting a job, and the page at phone width.
- Logins: inviting someone, the invite link, and what each role can and cannot open.

Tested against stand-ins, not the real services:

- The ServiceM8 and Xero refresh, with recorded-style responses.

Not tested, because it needs live accounts:

- Connecting the real ServiceM8 account and Xero organisation. Check the first refresh against ServiceM8's job totals and Xero's profit and loss before relying on the reports.

## Before you start

- **Vercel plan.** Vercel's free Hobby plan is for non-commercial use only. A business tool needs the Pro plan.
- **Accounts you need.** GitHub, Vercel, a Xero developer login, and an admin login to Polkadot's ServiceM8.
- **Data protection.** The app holds Polkadot's customer, invoice and pay data. Create the database in London (or the UK or EU), and have a data processing agreement in place with Vercel and the database provider.

## Part 1. Get it live (about 30 minutes)

### 1. Put the code on GitHub

Create a new **private** repository and put everything in this folder in it, including the hidden files `.gitignore` and `.env.example`.

### 2. Import it into Vercel

1. In Vercel, add a new project and import the repository. If this folder is not at the top of the repository, set **Root Directory** to it.
2. Leave every other build setting as it is. Deploy.

The first deploy finishes but the app does not work yet. It has no database.

### 3. Add the database

1. In the Vercel project, open **Storage** and create a Postgres database (Neon) in **London**.
2. Connect it to this project, for all environments.
3. Check the environment variables now include `DATABASE_URL`. The app also accepts `POSTGRES_URL`.

The app's functions run in London (`vercel.json`, region `lhr1`). If the database is elsewhere, change the region to match it.

### 4. Register the app with Xero

1. Sign in at developer.xero.com, open **My Apps** and create a new app of type **Web app**.
2. Company or application URL: your `APP_URL`.
3. Redirect URI: `APP_URL/api/xero/callback`
4. Copy the **Client id** and generate a **Client secret**.

### 5. Add the settings

In the project's **Environment Variables**, add:

| Name | Value |
| --- | --- |
| `ENCRYPTION_KEY` | A random string of at least 32 characters. Use a password generator. |
| `SETUP_TOKEN` | Any random string. You type it once in step 7. |
| `APP_URL` | The address of the app, for example `https://reports.polkadot.co.uk`. No slash at the end. |
| `XERO_CLIENT_ID` | From step 4. |
| `XERO_CLIENT_SECRET` | From step 4. |
| `CRON_SECRET` | A random string of at least 16 characters. Vercel sends it when it runs the morning refresh. |

Keep `ENCRYPTION_KEY` somewhere safe and never change it. It protects the ServiceM8 key and the Xero sign-in. If it changes, both have to be connected again.

### 6. Redeploy

Settings only apply to new deployments. Redeploy from the Deployments tab. Each deployment creates or updates the database tables by itself.

### 7. Create the first admin login

1. Open `APP_URL/setup`.
2. Enter the `SETUP_TOKEN`, the business name (a short name such as Polkadot, used on every report), and your name, email and password.

The setup page closes for good once the first login exists.

## Part 2. Connect ServiceM8 and Xero

In **Settings**:

1. **ServiceM8:** in Polkadot's ServiceM8, go to Settings, then **API Keys**, then **Add API Key**. Choose **Read Only**, copy the key and paste it into the app.
2. **Xero:** press **Connect Xero** and sign in as someone with access to Polkadot's organisation **and permission to see reports** in it. Without the reports permission the management accounts stay empty. If the login sees several organisations, choose the right one in Settings afterwards.
3. Press **Refresh data**. The first refresh reads everything since the **Data from** date and can take a few minutes. After that the app refreshes itself early every morning, and again in the background whenever an admin or editor opens a report and the data is more than four hours old. You can also refresh at any time.

What to expect from Xero:

- The app asks for read-only access: invoices and bills, payments, bank transactions, contacts, settings, and the profit and loss, balance sheet and aged reports.
- A new Xero app starts on the free Starter tier: 1,000 calls a day per organisation. Normal refreshes use a small part of that.
- A Xero connection lasts 60 days without use. The morning refresh keeps it alive.

Only an admin can connect or disconnect systems. Disconnecting deletes the copy of that system's data held by the app.

## Part 3. Set up the contractor report

In **Settings**:

1. **Contractors and rates.** Press **Add everyone from ServiceM8**, then open each person. Set how they are paid: **hourly** at their card rate, or a **share of the labour charged** (45% by default). Mark directors and office staff as not paid per job, so their jobs are flagged. Tick **Use their Xero bill** for contractors such as electricians whose bills name the job, and type the supplier name exactly as it appears on their Xero bills.
2. **Fixed fees.** Press **Add the standard fees** for boiler services, gas safety certificates, EICRs and the rest, and check the amounts. A fee applies when a job line contains one of its words.
3. **Weekly deductions.** Van, insurance, franchise fee, licences. Leave the end blank to run indefinitely.
4. **How job lines are read.** The app reads each ServiceM8 line as hourly labour, fixed-price labour, parking, materials, other costs paid back to the contractor, or ignore. It guesses from the line name and lists every guess, so you can confirm them with a rule once.

Anything typed against a single job, such as who did it, the bill it cost, or holding it out as a project, is kept on the **Job data** tab and applies to every report.

## Logins

Admins add people on the **Logins** tab. The app gives you a link to send them. It works once and lasts 7 days, and they choose their own password. The app does not send the email for you.

| | Admin | Editor | Viewer |
| --- | --- | --- | --- |
| Reports and Excel downloads | Yes | Yes | Yes, except Job data |
| Answer questions | Yes | Yes | Yes |
| Ask questions, chase debtors, edit projects | Yes | Yes | No |
| Adjust jobs, rates, fees and deductions | Yes | Yes | No |
| Refresh data | Yes | Yes | No |
| Connect ServiceM8 and Xero | Yes | No | No |
| Logins | Yes | No | No |

- **Forgotten passwords.** Open the person on the Logins tab and create a password reset link.
- **Leavers.** Tick "Disabled". They are signed out at once.

## Trying it with demonstration data

On your own computer, with a local Postgres database, you can load Polkadot's September 2026 figures as if they had come from ServiceM8 and Xero:

```
npm install
npm run migrate
npm run seed:demo
npm run dev
```

Put `DATABASE_URL` and `ENCRYPTION_KEY` in `.env.local` first, or set them in the shell. The seed replaces everything the reports hold and creates three logins, all with the password `demo-password-1`: `owner@demo.test` (admin), `editor@demo.test` (editor) and `jack@demo.test` (viewer). Never run it against the live database. It refuses hosted databases unless you force it.

The demo merges three spreadsheets written on different dates, so a few invoices disagree between them. On the Debtors tab the demo shows £64,892.61 owed on 1 October, not the email's £55,615.29. The automated tests check the email on its own and match it exactly.

## What version 1 does not do

- No two-step verification on sign in. Use long, unique passwords.
- It never writes to ServiceM8 or Xero. Chase emails are written for you to copy and send.
- No audit trail of who viewed what. Debtor chasing keeps a history of each change.

## Changing the app later

Push a change to GitHub and Vercel redeploys. To change the database, add a new numbered file in `migrations/`. It runs once, on the next deploy.

For developers: `npm run typecheck` and `npm test` run the type check and the tests.
