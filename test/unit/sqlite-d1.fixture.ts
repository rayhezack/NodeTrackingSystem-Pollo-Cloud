import { DatabaseSync } from 'node:sqlite';
import type { AtomicDatabase } from '../../worker/d1-record-store';
import type { D1PreparedStatement } from '../../worker/ai-tracking';
export function database(): AtomicDatabase {
  const sqlite = new DatabaseSync(':memory:');
  const statements = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
  return {
    prepare(sql: string) {
      const meta: { sql: string; values: unknown[] } = { sql, values: [] };
      const statement: D1PreparedStatement = {
        bind: (...values) => { meta.values = values; return statement; },
        first: async <T>() => (sqlite.prepare(sql).get(...meta.values as (string | number | null)[]) || null) as T | null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all(...meta.values as (string | number | null)[]) as T[] }),
        run: async () => sqlite.prepare(sql).run(...meta.values as (string | number | null)[]),
      };
      statements.set(statement, meta);
      return statement;
    },
    async batch(batch) {
      sqlite.exec('BEGIN');
      try {
        const results = batch.map((statement) => { const meta = statements.get(statement)!; return sqlite.prepare(meta.sql).run(...meta.values as (string | number | null)[]); });
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

