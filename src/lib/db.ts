import { Pool, types } from "pg";

// Keep dates as plain YYYY-MM-DD strings and bigints as numbers.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const store = globalThis as unknown as { __pool?: Pool };

function pool(): Pool {
  if (!store.__pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    store.__pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  }
  return store.__pool;
}

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool().query(text, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
