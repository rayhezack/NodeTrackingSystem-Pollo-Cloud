import {
  ensureSyncMonitor,
  startSyncRun,
  markSyncItems,
  refreshSyncRun,
  listSyncRuns,
} from './sync-monitor';
import {
  BITABLE_INSTANCES,
  searchBitableRecordPage,
  getBitableRecord,
  createBitableRecords,
  updateBitableRecords,
  deleteBitableRecords,
  type BitableInstanceKey,
} from './feishu-bitable';
import {
  ensureRecordStore,
  storeMode,
  recordCellText,
  type AtomicDatabase,
} from './d1-record-store';
import type { AiWorkerEnv } from './ai-tracking';
import {
  sendWorkflowNotification,
  type WorkflowTransitionNotification,
} from './feishu-notification';

export async function syncStatus(env: AiWorkerEnv) {
  if (!env.DB) throw new Error('数据库未启用');
  await ensureRecordStore(env.DB);
  const [tables, queue, migration] = await Promise.all([
    env.DB.prepare(
      'SELECT instance,COUNT(*) AS count FROM tracking_rows GROUP BY instance',
    ).all(),
    env.DB.prepare(
      'SELECT status,COUNT(*) AS count,MIN(created_at) AS oldest FROM tracking_sync_outbox GROUP BY status',
    ).all(),
    env.DB.prepare(
      "SELECT value FROM tracking_store_meta WHERE key='migration'",
    ).first<{ value: string }>(),
  ]);
  const errors = await env.DB.prepare(
    "SELECT id,instance,record_id,status,error,attempts FROM tracking_sync_outbox WHERE status IN ('failed','processing') ORDER BY id LIMIT 20",
  ).all();
  return {
    runs: await listSyncRuns(env.DB as AtomicDatabase),
    mode: await storeMode(env.DB),
    tables: tables.results || [],
    queue: queue.results || [],
    migration: migration ? JSON.parse(migration.value) : null,
    errors: errors.results || [],
  };
}

/** One bounded page per call. App writes are frozen until every table has completed. */
export async function importSyncPage(env: AiWorkerEnv) {
  const db = env.DB as AtomicDatabase;
  if (!db?.batch) throw new Error('数据库原子批处理不可用');
  await ensureRecordStore(db);
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS tracking_import_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_ms INTEGER NOT NULL)',
    )
    .run();
  const owner = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO tracking_import_lock(id,owner,until_ms) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE until_ms<?',
    )
    .bind(owner, Date.now() + 300000, Date.now())
    .run();
  if (
    (
      await db
        .prepare('SELECT owner FROM tracking_import_lock WHERE id=1')
        .first<{ owner: string }>()
    )?.owner !== owner
  )
    throw new Error('其他迁移请求正在执行，请稍后继续');
  const write = async (
    statements: import('./ai-tracking').D1PreparedStatement[],
  ) => {
    await db.batch([
      db
        .prepare(
          'INSERT INTO tracking_commit_checks(id,valid) SELECT ?,CASE WHEN (SELECT owner FROM tracking_import_lock WHERE id=1)=? THEN 1 ELSE 0 END',
        )
        .bind(owner, owner),
      ...statements,
      db.prepare('DELETE FROM tracking_commit_checks WHERE id=?').bind(owner),
    ]);
  };
  try {
    return await runImportPage(env, write);
  } finally {
    await db
      .prepare('DELETE FROM tracking_import_lock WHERE id=1 AND owner=?')
      .bind(owner)
      .run();
  }
}
async function runImportPage(
  env: AiWorkerEnv,
  write: (
    statements: import('./ai-tracking').D1PreparedStatement[],
  ) => Promise<void>,
) {
  const db = env.DB as AtomicDatabase;
  if (!db?.batch) throw new Error('数据库原子批处理不可用');
  await ensureRecordStore(db);
  if ((await storeMode(db)) === 'd1')
    throw new Error('已切换 D1，禁止用 Base 覆盖主库');
  const current = await db
    .prepare("SELECT value FROM tracking_store_meta WHERE key='migration'")
    .first<{ value: string }>();
  const state: { index: number; token?: string; count: number } = current
    ? JSON.parse(current.value)
    : { index: 0, count: 0 };
  const names = Object.keys(BITABLE_INSTANCES) as BitableInstanceKey[];
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS tracking_base_writer (id TEXT PRIMARY KEY, owner TEXT NOT NULL, started_at INTEGER NOT NULL)',
    )
    .run();
  await db
    .prepare(
      "INSERT INTO tracking_base_writer(id,owner,started_at) VALUES('global','d1-migration',?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(Date.now())
    .run();
  const lock = await db
    .prepare("SELECT owner FROM tracking_base_writer WHERE id='global'")
    .first<{ owner: string }>();
  if (lock?.owner !== 'd1-migration')
    throw new Error('Base 写入仍在进行，完成后再开始迁移');
  await db
    .prepare(
      "INSERT INTO tracking_store_meta(key,value) VALUES('mode','importing') ON CONFLICT(key) DO UPDATE SET value='importing'",
    )
    .run();
  const instance = names[state.index];
  if (!instance) throw new Error('导入状态不正确');
  const page = await searchBitableRecordPage(
    { ...env, LOCAL_STORE: undefined },
    instance,
    { pageSize: 200, pageToken: state.token },
  );
  if (page.hasMore && (!page.pageToken || page.pageToken === state.token))
    throw new Error('Base 分页不完整，已停止切换');
  const next = {
    index: state.index + (page.hasMore ? 0 : 1),
    token: page.hasMore ? page.pageToken : undefined,
    count: state.count + page.records.length,
  };
  const statements = page.records.flatMap((record) => {
    const fields = JSON.stringify(record.record);
    if (new TextEncoder().encode(fields).length > 60000)
      throw new Error(`${instance}/${record.id} 内容过长，需要迁移到附件`);
    return [
      db
        .prepare(
          'INSERT INTO tracking_rows(instance,id,fields) VALUES(?,?,?) ON CONFLICT(instance,id) DO UPDATE SET fields=excluded.fields',
        )
        .bind(instance, record.id, fields),
      db
        .prepare(
          'INSERT INTO tracking_base_mapping(instance,local_id,base_id) VALUES(?,?,?) ON CONFLICT(instance,local_id) DO NOTHING',
        )
        .bind(instance, record.id, record.id),
    ];
  });
  for (let offset = 0; offset < statements.length; offset += 10)
    await write(statements.slice(offset, offset + 10));
  statements.length = 0;
  statements.push(
    db
      .prepare(
        "INSERT INTO tracking_store_meta(key,value) VALUES('migration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .bind(JSON.stringify(next)),
  );
  if (next.index === names.length) {
    statements.push(
      db.prepare("UPDATE tracking_store_meta SET value='d1' WHERE key='mode'"),
    );
    statements.push(
      db.prepare(
        "DELETE FROM tracking_base_writer WHERE id='global' AND owner='d1-migration'",
      ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO tracking_store_meta(key,value) VALUES('activated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .bind(String(Date.now())),
    );
  }
  await write(statements);
  return {
    ...next,
    total: names.length,
    complete: next.index === names.length,
  };
}

/** A single durable consumer. Ordered jobs prevent an older Base update overwriting a newer one. */
export async function drainSync(env: AiWorkerEnv, limit = 50) {
  const db = env.DB as AtomicDatabase;
  await ensureSyncMonitor(db);
  if (
    !(await db
      .prepare(
        "SELECT id FROM tracking_sync_outbox WHERE status!='synced' LIMIT 1",
      )
      .first())
  )
    return { processed: 0 };
  const owner = crypto.randomUUID();
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS tracking_sync_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_ms INTEGER NOT NULL)',
    )
    .run();
  await db
    .prepare(
      'INSERT INTO tracking_sync_lock(id,owner,until_ms) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE until_ms<?',
    )
    .bind(owner, Date.now() + 240000, Date.now())
    .run();
  const lock = await db
    .prepare('SELECT owner FROM tracking_sync_lock WHERE id=1')
    .first<{ owner: string }>();
  if (lock?.owner !== owner) return { processed: 0 };
  let processed = 0;
  let runId = '';
  try {
    runId = await startSyncRun(db, 'automatic');
    const jobs = await db
      .prepare(
        "SELECT id,instance,record_id,payload,status,attempts FROM tracking_sync_outbox WHERE status!='synced' AND id IN (SELECT job_id FROM tracking_sync_run_items WHERE run_id=?) ORDER BY id LIMIT ?",
      )
      .bind(runId, limit)
      .all<{
        id: number;
        instance: string;
        record_id: string;
        payload: string;
        status: string;
        attempts: number;
      }>();
    const mapping = await db
      .prepare('SELECT local_id,base_id FROM tracking_base_mapping')
      .all<{ local_id: string; base_id: string }>();
    const ids = new Map(
      (mapping.results || []).map((row) => [row.local_id, row.base_id]),
    );
    const pending = jobs.results || [];
    for (let index = 0; index < pending.length;) {
      const job = pending[index];
      if (
        job.status === 'processing' ||
        (job.status === 'failed' && job.attempts >= 5)
      ) {
        const reason =
          job.status === 'processing'
            ? '上次执行结果待核对，停止重放，避免重复创建'
            : '重试次数已用尽，请管理员处理后重试';
        await markSyncItems(db, runId, [job.id], 'blocked', reason);
        await refreshSyncRun(db, runId, reason);
        break;
      }
      try {
        await prepareReferencedRecords(env, db, job, ids, runId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '关联准备失败';
        await db
          .prepare(
            "UPDATE tracking_sync_outbox SET status='failed',error=? WHERE id=? AND status!='processing'",
          )
          .bind(reason, job.id)
          .run();
        await markSyncItems(db, runId, [job.id], 'blocked', reason);
        await refreshSyncRun(db, runId, reason);
        break;
      }
      const group = [job];
      const kind =
        job.instance === '__notification'
          ? 'notification'
          : job.payload === 'null'
            ? 'delete'
            : ids.has(job.record_id)
              ? 'update'
              : 'create';
      // Batch consecutive records only; dependencies always finish before their children.
      if (kind === 'update' || kind === 'create') {
        for (
          let next = index + 1;
          next < pending.length && group.length < 25;
          next++
        ) {
          const candidate = pending[next];
          if (
            candidate.instance !== job.instance ||
            candidate.status === 'processing' ||
            candidate.attempts >= 5 ||
            candidate.payload === 'null' ||
            (ids.has(candidate.record_id) ? 'update' : 'create') !== kind ||
            group.some((item) => item.record_id === candidate.record_id)
          )
            break;
          try {
            translateIds(JSON.parse(candidate.payload), ids);
          } catch {
            break;
          }
          if (
            group.reduce((size, item) => size + item.payload.length, 0) +
              candidate.payload.length >
            200000
          )
            break;
          group.push(candidate);
        }
      }
      let started = false;
      try {
        const instance = job.instance as BitableInstanceKey;
        if (kind !== 'notification' && !BITABLE_INSTANCES[instance])
          throw new Error('未知同步表');
        const translated = group.map(
          (item) =>
            translateIds(JSON.parse(item.payload), ids) as Record<
              string,
              unknown
            > | null,
        );
        await db.batch(
          group.map((item) =>
            db
              .prepare(
                "UPDATE tracking_sync_outbox SET status='processing',attempts=attempts+1 WHERE id=? AND status IN ('pending','failed')",
              )
              .bind(item.id),
          ),
        );
        started = true;
        await markSyncItems(
          db,
          runId,
          group.map((item) => item.id),
          'running',
        );
        const remote = { ...env, LOCAL_STORE: undefined, DB: undefined };
        const mappings: import('./ai-tracking').D1PreparedStatement[] = [];
        if (kind === 'notification') {
          const result = await sendWorkflowNotification(
            remote,
            JSON.parse(job.payload) as WorkflowTransitionNotification,
          );
          if (result.failedCount)
            throw new Error(result.errors?.join(';') || '通知发送失败');
        } else if (kind === 'delete') {
          const baseId = ids.get(job.record_id);
          if (baseId && (await getBitableRecord(remote, instance, baseId)))
            await deleteBitableRecords(remote, instance, [baseId]);
        } else if (kind === 'update') {
          await updateBitableRecords(
            remote,
            instance,
            group.map((item, i) => ({
              id: ids.get(item.record_id)!,
              record: translated[i]!,
            })),
          );
        } else {
          const created = await createBitableRecords(
            remote,
            instance,
            translated as Record<string, unknown>[],
          );
          if (
            created.length !== group.length ||
            created.some((item) => !item.id)
          )
            throw new Error('Base 返回记录不完整，请核对后恢复');
          group.forEach((item, i) =>
            mappings.push(
              db
                .prepare(
                  'INSERT INTO tracking_base_mapping(instance,local_id,base_id) VALUES(?,?,?)',
                )
                .bind(instance, item.record_id, created[i].id),
            ),
          );
          // Mapping and acknowledgment must commit together after the external create.
          await db.batch([
            ...mappings,
            ...group.map((item) =>
              db
                .prepare(
                  "UPDATE tracking_sync_outbox SET status='synced',finished_at=?,error=NULL WHERE id=?",
                )
                .bind(Date.now(), item.id),
            ),
          ]);
          group.forEach((item, i) => ids.set(item.record_id, created[i].id));
        }
        if (kind !== 'create')
          await db.batch(
            group.map((item) =>
              db
                .prepare(
                  "UPDATE tracking_sync_outbox SET status='synced',finished_at=?,error=NULL WHERE id=?",
                )
                .bind(Date.now(), item.id),
            ),
          );
        await markSyncItems(
          db,
          runId,
          group.map((item) => item.id),
          'completed',
        );
        await refreshSyncRun(db, runId);
        processed += group.length;
        index += group.length;
      } catch (error) {
        await db.batch(
          group.map((item) =>
            db
              .prepare(
                "UPDATE tracking_sync_outbox SET status=?,error=? WHERE id=? AND status!='synced'",
              )
              .bind(
                started && (kind === 'create' || kind === 'notification')
                  ? 'processing'
                  : 'failed',
                error instanceof Error ? error.message : '同步失败',
                item.id,
              ),
          ),
        );
        const reason = error instanceof Error ? error.message : '同步失败';
        await markSyncItems(
          db,
          runId,
          group.map((item) => item.id),
          'failed',
          reason,
        );
        await refreshSyncRun(db, runId, reason);
        break;
      }
    }
    const active = (await listSyncRuns(db)).find((run) => run.id === runId);
    if (active?.status !== 'blocked') await refreshSyncRun(db, runId);
  } catch (error) {
    if (runId)
      await refreshSyncRun(
        db,
        runId,
        error instanceof Error ? error.message : '同步执行中断',
      );
    throw error;
  } finally {
    await db
      .prepare('DELETE FROM tracking_sync_lock WHERE id=1 AND owner=?')
      .bind(owner)
      .run();
  }
  return { processed };
}
function translateIds(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('d1_')) {
    const mapped = ids.get(value);
    if (!mapped) throw new Error(`关联记录尚未同步：${value}`);
    return mapped;
  }
  if (Array.isArray(value)) return value.map((item) => translateIds(item, ids));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        translateIds(item, ids),
      ]),
    );
  return value;
}

interface SyncJob {
  id: number;
  instance: string;
  record_id: string;
  payload: string;
  status: string;
  attempts: number;
}
function unresolvedIds(value: unknown, ids: Map<string, string>): string[] {
  if (typeof value === 'string')
    return value.startsWith('d1_') && !ids.has(value) ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((item) => unresolvedIds(item, ids));
  if (value && typeof value === 'object')
    return Object.values(value).flatMap((item) => unresolvedIds(item, ids));
  return [];
}
/** Allocate IDs first, then let the original ordered jobs fill every deferred link before acknowledgment. */
async function prepareReferencedRecords(
  env: AiWorkerEnv,
  db: AtomicDatabase,
  job: SyncJob,
  ids: Map<string, string>,
  runId: string,
) {
  const payload = JSON.parse(job.payload) as Record<string, unknown> | null;
  if (!payload || job.instance === '__notification') return;
  const missing = [...new Set(unresolvedIds(payload, ids))];
  if (!missing.length) return;
  const allocate = async (candidate: SyncJob) => {
    if (ids.has(candidate.record_id)) return;
    if (candidate.status === 'processing' || candidate.attempts >= 5)
      throw new Error(`关联任务 ${candidate.id} 结果待核对或重试已用尽`);
    const fields = JSON.parse(candidate.payload) as Record<
      string,
      unknown
    > | null;
    if (!fields || !BITABLE_INSTANCES[candidate.instance as BitableInstanceKey])
      throw new Error('关联记录已删除或来源不正确，需人工核对');
    const ready = Object.fromEntries(
      Object.entries(fields).filter(
        ([, value]) => !unresolvedIds(value, ids).length,
      ),
    );
    const translated = translateIds(ready, ids) as Record<string, unknown>;
    await db
      .prepare(
        "UPDATE tracking_sync_outbox SET status='processing',attempts=attempts+1 WHERE id=?",
      )
      .bind(candidate.id)
      .run();
    await markSyncItems(
      db,
      runId,
      [candidate.id],
      'running',
      '创建记录，关联将在 ID 分配后补全',
    );
    try {
      const created = await createBitableRecords(
        { ...env, LOCAL_STORE: undefined, DB: undefined },
        candidate.instance as BitableInstanceKey,
        [translated],
      );
      if (created.length !== 1 || !created[0].id)
        throw new Error('关联记录创建结果不完整');
      await db.batch([
        db
          .prepare(
            'INSERT INTO tracking_base_mapping(instance,local_id,base_id) VALUES(?,?,?)',
          )
          .bind(candidate.instance, candidate.record_id, created[0].id),
        db
          .prepare(
            "UPDATE tracking_sync_outbox SET status='pending',error='Base ID 已分配，等待关联补全' WHERE id=?",
          )
          .bind(candidate.id),
      ]);
      ids.set(candidate.record_id, created[0].id);
      await markSyncItems(
        db,
        runId,
        [candidate.id],
        'pending',
        'Base ID 已分配，等待关联补全',
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : '关联记录创建结果不明确';
      await db
        .prepare('UPDATE tracking_sync_outbox SET error=? WHERE id=?')
        .bind(reason, candidate.id)
        .run();
      await markSyncItems(db, runId, [candidate.id], 'blocked', reason);
      throw error; // Keep processing: an external create may have committed. Never blindly replay it.
    }
  };
  const dependencies: SyncJob[] = [];
  for (const id of missing) {
    if (ids.has(id) || id === job.record_id) continue;
    const dependency = await db
      .prepare(
        "SELECT id,instance,record_id,payload,status,attempts FROM tracking_sync_outbox WHERE record_id=? AND status!='synced' ORDER BY id LIMIT 1",
      )
      .bind(id)
      .first<SyncJob>();
    if (!dependency)
      throw new Error(`缺少关联记录的同步任务：${id}，需人工核对`);
    if (dependency.status === 'processing' || dependency.attempts >= 5)
      throw new Error(`关联任务 ${dependency.id} 结果待核对或重试已用尽`);
    dependencies.push(dependency);
  }
  if (!ids.has(job.record_id)) await allocate(job);
  for (const dependency of dependencies) await allocate(dependency);
}

/** Recover an uncertain create only after an administrator identifies and verifies the existing Base record. */
export async function reconcileSyncJob(
  env: AiWorkerEnv,
  jobId: number,
  baseId: string,
) {
  const db = env.DB as AtomicDatabase;
  const lock = await db
    .prepare('SELECT until_ms FROM tracking_sync_lock WHERE id=1')
    .first<{ until_ms: number }>();
  if (lock && lock.until_ms > Date.now())
    throw new Error('同步仍在执行，请稍后核对');
  const job = await db
    .prepare(
      "SELECT instance,record_id,payload FROM tracking_sync_outbox WHERE id=? AND status='processing'",
    )
    .bind(jobId)
    .first<{ instance: string; record_id: string; payload: string }>();
  if (!job || job.instance === '__notification')
    throw new Error('该任务不支持记录关联恢复');
  const instance = job.instance as BitableInstanceKey;
  if (!BITABLE_INSTANCES[instance] || !/^rec[a-zA-Z0-9]+$/.test(baseId))
    throw new Error('Base 记录 ID 不正确');
  const record = await getBitableRecord(
    { ...env, LOCAL_STORE: undefined, DB: undefined },
    instance,
    baseId,
  );
  if (!record) throw new Error('Base 记录不存在');
  const desired = JSON.parse(job.payload) as Record<string, unknown>;
  const keys = ['evt_id', '需求ID', '参数名', '枚举值'].filter(
    (key) => desired[key],
  );
  if (
    !keys.length ||
    keys.some(
      (key) =>
        recordCellText(desired[key]) !== recordCellText(record.record[key]),
    )
  )
    throw new Error('Base 记录业务标识与待同步记录不匹配，未恢复');
  const existing = await db
    .prepare(
      'SELECT local_id FROM tracking_base_mapping WHERE instance=? AND base_id=?',
    )
    .bind(instance, baseId)
    .first<{ local_id: string }>();
  if (existing && existing.local_id !== job.record_id)
    throw new Error('该 Base 记录已关联其他主库记录');
  await db.batch([
    db
      .prepare(
        'INSERT INTO tracking_base_mapping(instance,local_id,base_id) VALUES(?,?,?) ON CONFLICT(instance,local_id) DO NOTHING',
      )
      .bind(instance, job.record_id, baseId),
    db
      .prepare(
        "UPDATE tracking_sync_outbox SET status='pending',error=NULL WHERE id=? AND status='processing'",
      )
      .bind(jobId),
  ]);
  return { success: true };
}
