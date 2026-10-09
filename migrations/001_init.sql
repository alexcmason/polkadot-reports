-- One business's reporting: logins, the data read from its ServiceM8 and Xero, and the
-- settings that turn it into the weekly contractor report, projects tracker, debtors chase
-- list and management accounts.

create extension if not exists pgcrypto;

-- Logins. Admins manage connections and logins, editors prepare the reports, viewers read
-- them and answer questions.
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  status text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  invite_token_hash text,
  invite_expires_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table login_attempts (
  id bigserial primary key,
  email text not null,
  succeeded boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_email_idx on login_attempts (email, at);

-- One connection per system. Secrets are encrypted with ENCRYPTION_KEY. The generation moves
-- on whenever a connection is switched, re-keyed or cleared, so a refresh that started with
-- the old one can no longer write.
create table integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('xero', 'servicem8')),
  account_name text not null default '',
  tenant_id text not null default '',
  secret_enc text not null,
  access_token_enc text,
  access_expires_at timestamptz,
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  sync_cursor jsonb not null default '{}',
  last_sync_at timestamptz,
  last_error text not null default '',
  generation int not null default 1,
  connected_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- A copy of every record read from ServiceM8 and Xero, as the API returned it.
create table source_records (
  source text not null check (source in ('servicem8', 'xero')),
  kind text not null,
  ext_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source, kind, ext_id)
);

create table sync_runs (
  id bigserial primary key,
  trigger text not null default 'manual' check (trigger in ('manual', 'cron')),
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  detail jsonb not null default '{}',
  error text not null default '',
  started_by uuid references users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index sync_runs_started_idx on sync_runs (started_at desc);
-- At most one refresh runs at a time, even when two start at the same instant.
create unique index sync_runs_one_running on sync_runs (status) where status = 'running';

-- A single row of settings.
create table report_settings (
  id boolean primary key default true check (id),
  business_name text not null default '',
  sync_from date not null default '2026-01-01',
  labour_share numeric(6, 4) not null default 0.45,
  cis_rate numeric(6, 4) not null default 0.20,
  vat_rate numeric(6, 4) not null default 0.20,
  week_ends_on int not null default 4 check (week_ends_on between 1 and 7),
  pay_run_lag_days int not null default 28,
  project_categories text[] not null default '{"Refurbishment Works"}',
  recall_categories text[] not null default '{"Recall"}',
  sales_type_tracking text not null default 'Sales Type',
  chase_after_hours int not null default 48,
  low_margin_pct numeric(6, 4) not null default 0.15,
  updated_at timestamptz not null default now()
);

-- Who does the work, and how their cost is worked out.
create table contractors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sm8_staff_uuids text[] not null default '{}',
  kind text not null default 'contractor' check (kind in ('contractor', 'staff')),
  cost_basis text not null default 'hourly' check (cost_basis in ('hourly', 'labour_share')),
  hourly_rate numeric(10, 2),
  use_bills boolean not null default false,
  bill_supplier text not null default '',
  active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- Fixed fees paid per job, such as a boiler service, matched on the job's lines.
create table fixed_fees (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  amount numeric(10, 2) not null,
  keywords text[] not null default '{}',
  notes text not null default '',
  sort int not null default 0
);

-- Weekly deductions from a contractor's pay. A row with week_ending set applies to that week only.
create table deductions (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references contractors (id) on delete cascade,
  label text not null,
  amount numeric(10, 2) not null,
  starts_on date,
  ends_on date,
  week_ending date,
  created_at timestamptz not null default now()
);
create index deductions_contractor_idx on deductions (contractor_id);

-- How a ServiceM8 job line is read: labour by the hour, fixed-price labour, parking, materials.
create table line_rules (
  id uuid primary key default gen_random_uuid(),
  match text not null,
  line_class text not null check (line_class in ('labour_hourly', 'labour_fixed', 'parking', 'materials', 'other', 'ignore')),
  sort int not null default 0
);
create index line_rules_sort_idx on line_rules (sort);

-- Anything typed in against one job: who did it, what it cost, which week it belongs to.
create table job_adjustments (
  job_no text primary key,
  contractor_id uuid references contractors (id) on delete set null,
  cost_basis text check (cost_basis in ('hourly', 'labour_share', 'fixed_fee', 'actual_bill')),
  fixed_fee_id uuid references fixed_fees (id) on delete set null,
  actual_bill numeric(10, 2),
  bill_ref text not null default '',
  materials_paid_by text check (materials_paid_by in ('contractor', 'business')),
  business_materials numeric(10, 2),
  contractor_extra numeric(10, 2),
  treatment text not null default 'include' check (treatment in ('include', 'exclude', 'project')),
  week_ending date,
  note text not null default '',
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Projects and quoted installation work, held out of the contractor figures.
create table projects (
  id uuid primary key default gen_random_uuid(),
  customer text not null,
  site text not null default '',
  works text not null default '',
  sales_type text not null default 'RE',
  status text not null default 'quoted'
    check (status in ('awaiting_price', 'quoted', 'in_progress', 'completed', 'lost')),
  job_numbers text[] not null default '{}',
  subcontractor text not null default '',
  sub_supplier text not null default '',
  sub_estimate_no text not null default '',
  sub_quoted numeric(12, 2),
  sub_cost_override numeric(12, 2),
  price_override numeric(12, 2),
  goodwill boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  xero_invoice_id text,
  supplier text not null default '',
  ref text not null default '',
  date date,
  description text not null default '',
  amount numeric(12, 2) not null,
  tie text not null default 'tied' check (tie in ('tied', 'probable')),
  is_sub boolean not null default false,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index project_costs_project_idx on project_costs (project_id);
create unique index project_costs_bill_idx on project_costs (xero_invoice_id) where xero_invoice_id is not null;

-- Where each unpaid invoice stands with the person chasing it.
create table debtor_chases (
  job_no text primary key,
  status text not null default 'to_chase'
    check (status in ('to_chase', 'chased', 'promised', 'queried', 'paid', 'write_off', 'hold')),
  note text not null default '',
  last_chased_on date,
  chase_count int not null default 0,
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table debtor_events (
  id bigserial primary key,
  job_no text not null,
  action text not null,
  note text not null default '',
  by_user uuid references users (id) on delete set null,
  by_name text not null default '',
  at timestamptz not null default now()
);
create index debtor_events_job_idx on debtor_events (job_no, at desc);

-- Questions for the business, answered in the app instead of in yellow cells.
create table report_queries (
  id uuid primary key default gen_random_uuid(),
  topic text not null default 'contractors'
    check (topic in ('contractors', 'projects', 'debtors', 'management', 'general')),
  week_ending date,
  job_no text not null default '',
  subject text not null,
  detail text not null default '',
  action_taken text not null default '',
  ask text not null default '',
  answer text not null default '',
  status text not null default 'open' check (status in ('open', 'answered', 'resolved')),
  asked_by uuid references users (id) on delete set null,
  answered_by uuid references users (id) on delete set null,
  answered_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index report_queries_status_idx on report_queries (status, created_at desc);
