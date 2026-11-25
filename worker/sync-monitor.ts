import {
  ensureRecordStore,
  recordCellText,
  type AtomicDatabase,
} from './d1-record-store';
import type {
  DataSyncRun,
  DataSyncRunDetail,
  DataSyncRunItem,
} from '../shared/api.interface';

const initialized = new WeakMap<object, Promise<void>>();
export async function ensureSyncMonitor(db: AtomicDatabase) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = (async () => {
      await ensureRecordStore(db);
      await db
        .prepare(
          'CREATE TABLE IF NOT EXISTS tracking_sync_runs (id TEXT PRIMARY KEY, trigger TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT)',
        )
        .run();
      await db
        .prepare(
          'CREATE INDEX IF NOT EXISTS idx_sync_run_started ON tracking_sync_runs(started_at DESC)',
        )
        .run();
      await db
        .prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_active_run ON tracking_sync_runs((1)) WHERE status IN ('queued','running')",
        )
        .run();
      await db
        .prepare(
          'CREATE TABLE IF NOT EXISTS tracking_sync_run_items (run_id TEXT NOT NULL,job_id INTEGER NOT NULL,instance TEXT NOT NULL,record_id TEXT NOT NULL,label TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER,finished_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(run_id,job_id))',
        )
        .run();
    })().catch((error: unknown) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, pending);
  }
  await pending;
}

export async function startSyncRun(
  db: AtomicDatabase,
  trigger: 'manual' | 'automatic',
  retry = false,
): Promise<string> {
  await ensureSyncMonitor(db);
  const active = await db
    .prepare(
      "SELECT id FROM tracking_sync_runs WHERE status IN ('queued','running')",
    )
    .first<{ id: string }>();
  if (active) return active.id;
  const id = crypto.randomUUID();
  // INSERT SELECT snapshots the entire current queue, independent of pagination or browser lifetime.
  const statements = [
    db
      .prepare(
        "INSERT INTO tracking_sync_runs(id,trigger,status,started_at) VALUES(?,?,'queued',?)",
      )
      .bind(id, trigger, Date.now()),
  ];
  if (retry)
    statements.push(
      db.prepare(
        "UPDATE tracking_sync_outbox SET status='pending',error=NULL WHERE status='failed'",
      ),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO tracking_sync_run_items(run_id,job_id,instance,record_id,label,operation,status,attempts,error) SELECT ?,id,instance,record_id,'',CASE WHEN instance='__notification' THEN 'notification' WHEN payload='null' THEN 'delete' WHEN EXISTS(SELECT 1 FROM tracking_base_mapping m WHERE m.instance=tracking_sync_outbox.instance AND m.local_id=record_id) THEN 'update' ELSE 'create' END,'pending',attempts,error FROM tracking_sync_outbox WHERE status!='synced'",
      )
      .bind(id),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const winner = await db
      .prepare(
        "SELECT id FROM tracking_sync_runs WHERE status IN ('queued','running')",
      )
      .first<{ id: string }>();
    if (winner) return winner.id;
    throw error;
  }
  await refreshSyncRun(db, id);
  return id;
}

export async function markSyncItems(
  db: AtomicDatabase,
  runId: string,
  ids: number[],
  status: DataSyncRunItem['status'],
  error: string | null = null,
) {
  if (!ids.length) return;
  const now = Date.now();
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          'UPDATE tracking_sync_run_items SET status=?,started_at=COALESCE(started_at,?),finished_at=?,error=?,attempts=(SELECT attempts FROM tracking_sync_outbox WHERE id=?) WHERE run_id=? AND job_id=?',
        )
        .bind(
          status,
          now,
          status === 'running' ? null : now,
          error,
          id,
          runId,
          id,
        ),
    ),
  );
}

export async function refreshSyncRun(
  db: AtomicDatabase,
  id: string,
  error?: string,
) {
  // Reconcile a process interruption after the durable outbox acknowledgment.
  await db
    .prepare(
      "UPDATE tracking_sync_run_items SET status='completed',finished_at=COALESCE(finished_at,(SELECT finished_at FROM tracking_sync_outbox WHERE id=job_id)),error=NULL WHERE run_id=? AND job_id IN (SELECT id FROM tracking_sync_outbox WHERE status='synced')",
    )
    .bind(id)
    .run();
  const counts = await db
    .prepare(
      "SELECT COUNT(*) AS total,SUM(status='completed') AS completed,SUM(status IN ('failed','blocked')) AS failed FROM tracking_sync_run_items WHERE run_id=?",
    )
    .bind(id)
    .first<{ total: number; completed: number; failed: number }>();
  const done = counts?.total === (counts?.completed || 0);
  const blocked = Boolean(error || counts?.failed);
  await db
    .prepare(
      'UPDATE tracking_sync_runs SET status=?,finished_at=?,error=? WHERE id=?',
    )
    .bind(
      done ? 'completed' : blocked ? 'blocked' : 'running',
      done || blocked ? Date.now() : null,
      error || null,
      id,
    )
    .run();
}

export async function listSyncRuns(db: AtomicDatabase): Promise<DataSyncRun[]> {
  await ensureSyncMonitor(db);
  const result = await db
    .prepare(
      `SELECT r.id,r.trigger,r.status,r.started_at AS startedAt,r.finished_at AS finishedAt,r.error,
    COUNT(i.job_id) AS total,COALESCE(SUM(i.status='completed'),0) AS completed,COALESCE(SUM(i.status IN ('failed','blocked')),0) AS failed,
    COALESCE(SUM(i.status='running'),0) AS running,COALESCE(SUM(i.status='pending'),0) AS pending
    FROM (SELECT * FROM tracking_sync_runs ORDER BY started_at DESC LIMIT 10) r LEFT JOIN tracking_sync_run_items i ON i.run_id=r.id GROUP BY r.id ORDER BY r.started_at DESC LIMIT 10`,
    )
    .all<DataSyncRun>();
  return result.results || [];
}

export async function syncRunDetail(
  db: AtomicDatabase,
  id: string,
  page = 0,
  status = 'all',
): Promise<DataSyncRunDetail | null> {
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    !['all', 'pending', 'running', 'completed', 'failed', 'blocked'].includes(
      status,
    )
  )
    throw new Error('任务筛选参数不正确');
  const run = (await listSyncRuns(db)).find((item) => item.id === id);
  if (!run) return null;
  const filter = status === 'all' ? '' : ' AND i.status=?';
  const bindings = status === 'all' ? [id] : [id, status];
  const result = await db
    .prepare(
      `SELECT i.job_id AS jobId,i.instance,i.record_id AS recordId,i.operation,i.status,i.started_at AS startedAt,i.finished_at AS finishedAt,i.attempts,i.error,o.payload,r.fields AS recordFields
    FROM tracking_sync_run_items i JOIN tracking_sync_outbox o ON o.id=i.job_id LEFT JOIN tracking_rows r ON r.instance=i.instance AND r.id=i.record_id WHERE i.run_id=?${filter} ORDER BY i.job_id LIMIT 25 OFFSET ?`,
    )
    .bind(...bindings, page * 25)
    .all<DataSyncRunItem & { payload: string; recordFields: string | null }>();
  const count = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM tracking_sync_run_items i WHERE i.run_id=?${filter}`,
    )
    .bind(...bindings)
    .first<{ total: number }>();
  return {
    run,
    page,
    pageSize: 25,
    totalItems: count?.total || 0,
    items: (result.results || []).map(({ payload, recordFields, ...item }) => {
      const patch = JSON.parse(payload) as Record<string, unknown> | null;
      const fields = patch
        ? {
            ...(recordFields
              ? (JSON.parse(recordFields) as Record<string, unknown>)
              : {}),
            ...patch,
          }
        : null;
      const label = fields
        ? [fields.evt_id, fields['参数名'], fields['枚举值']]
            .map(recordCellText)
            .filter(Boolean)
            .join(' · ')
        : '删除记录';
      return {
        ...item,
        label:
          label ||
          (item.instance === '__notification' ? '流程通知' : item.recordId),
      };
    }),
  };
}
