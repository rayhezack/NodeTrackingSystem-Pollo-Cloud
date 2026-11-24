import type { AiTrackingJob, AiTrackingGenerationProgress, GenerateAiTrackingDraftRequest } from '../shared/api.interface';
import { generateAiDraft, getAiConfigStatus, getAiDraft, encodeAiJobPayload, decodeAiJobPayload, type AiWorkerEnv } from './ai-tracking';
import { getTrackingDetail } from './tracking-read';
import { TrackingWriteError } from './tracking-write';

type JobStatus = AiTrackingJob['status'];
interface JobRow { id: string; actor_id: string; record_id: string; status: JobStatus; created_at: number; updated_at: number; payload: string; runner: string | null; lease_until: number; }
interface JobState { input: GenerateAiTrackingDraftRequest; progress: AiTrackingGenerationProgress[]; cache: Record<string, unknown>; draftId?: string; error?: string; }
const schemas: WeakMap<object, Promise<void>> = new WeakMap();
const LEASE_MS = 45_000;
const localRunners: Map<string, AbortController> = new Map();

async function schema(env: AiWorkerEnv): Promise<void> {
  if (!env.DB) throw new TrackingWriteError('后台任务数据库未启用', 503);
  let pending = schemas.get(env.DB);
  if (!pending) {
    pending = env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_tracking_jobs (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, record_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL,
      runner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)`).run().then(async () => {
      await env.DB!.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_active_job ON ai_tracking_jobs(actor_id, record_id) WHERE status IN ('queued', 'running', 'paused')").run();
    }).catch((error: unknown) => { schemas.delete(env.DB!); throw error; });
    schemas.set(env.DB, pending);
  }
  await pending;
}
async function load(env: AiWorkerEnv, id: string, actorId?: string): Promise<{ row: JobRow; state: JobState }> {
  await schema(env);
  const row = await env.DB!.prepare(`SELECT * FROM ai_tracking_jobs WHERE id = ?${actorId ? ' AND actor_id = ?' : ''}`)
    .bind(...(actorId ? [id, actorId] : [id])).first<JobRow>();
  if (!row) throw new TrackingWriteError('任务不存在或无权访问', 404);
  return { row, state: await decodeAiJobPayload(env, row.payload) as JobState };
}
function view(row: JobRow, state: JobState): AiTrackingJob {
  return { id: row.id, recordId: row.record_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    progress: state.progress, draftId: state.draftId, error: state.error };
}
export async function getAiJob(env: AiWorkerEnv, actorId: string, id: string): Promise<{ job: AiTrackingJob }> {
  const { row, state } = await load(env, id, actorId);
  return { job: view(row, state) };
}
export async function listAiJobs(env: AiWorkerEnv, actorId: string, recordId?: string): Promise<{ jobs: AiTrackingJob[] }> {
  await schema(env);
  const rows = await env.DB!.prepare(`SELECT * FROM ai_tracking_jobs WHERE actor_id = ?${recordId ? ' AND record_id = ?' : ''} ORDER BY created_at DESC LIMIT 30`)
    .bind(...(recordId ? [actorId, recordId] : [actorId])).all<JobRow>();
  return { jobs: await Promise.all((rows.results || []).map(async (row: JobRow) => view(row, await decodeAiJobPayload(env, row.payload) as JobState))) };
}
export async function createAiJob(env: AiWorkerEnv, actorId: string, recordId: string, input: GenerateAiTrackingDraftRequest, origin: string): Promise<{ job: AiTrackingJob }> {
  await schema(env);
  if (!getAiConfigStatus(env, origin).configured) throw new TrackingWriteError('后台任务配置不完整，请联系管理员', 503);
  const detail = (await getTrackingDetail(env, recordId, actorId)).data;
  if (!detail.permissions.canEditDesign) throw new TrackingWriteError('当前用户无埋点设计权限', 403);
  const id = crypto.randomUUID();
  const now = Date.now();
  const state: JobState = { input, progress: [], cache: {} };
  const payload = await encodeAiJobPayload(env, id, state);
  // Partial unique index makes create/retry idempotent under concurrent requests.
  await env.DB!.prepare("INSERT OR IGNORE INTO ai_tracking_jobs(id, actor_id, record_id, status, created_at, updated_at, payload) VALUES(?, ?, ?, 'queued', ?, ?, ?)")
    .bind(id, actorId, recordId, now, now, payload).run();
  const row = await env.DB!.prepare("SELECT * FROM ai_tracking_jobs WHERE actor_id = ? AND record_id = ? AND status IN ('queued', 'running', 'paused') ORDER BY created_at DESC LIMIT 1").bind(actorId, recordId).first<JobRow>();
  if (!row) throw new TrackingWriteError('创建后台任务失败，请重试', 503);
  return getAiJob(env, actorId, row.id);
}
export async function cancelAiJob(env: AiWorkerEnv, actorId: string, id: string): Promise<{ job: AiTrackingJob }> {
  const { row } = await load(env, id, actorId);
  if (row.status === 'queued' || row.status === 'running' || row.status === 'paused') {
    await env.DB!.prepare("UPDATE ai_tracking_jobs SET status = 'cancelled', updated_at = ?, lease_until = 0 WHERE id = ? AND actor_id = ? AND status IN ('queued', 'running', 'paused')").bind(Date.now(), id, actorId).run();
    localRunners.get(id)?.abort(new Error('任务已手动停止'));
  }
  return getAiJob(env, actorId, id);
}

export async function pauseAiJob(env: AiWorkerEnv, actorId: string, id: string): Promise<{ job: AiTrackingJob }> {
  await load(env, id, actorId);
  await env.DB!.prepare("UPDATE ai_tracking_jobs SET status = 'paused', updated_at = ?, lease_until = 0 WHERE id = ? AND actor_id = ? AND status IN ('queued', 'running')").bind(Date.now(), id, actorId).run();
  localRunners.get(id)?.abort(new Error('任务已暂停'));
  return getAiJob(env, actorId, id);
}
export async function resumeAiJob(env: AiWorkerEnv, actorId: string, id: string): Promise<{ job: AiTrackingJob }> {
  await load(env, id, actorId);
  await env.DB!.prepare("UPDATE ai_tracking_jobs SET status = 'queued', updated_at = ?, lease_until = 0 WHERE id = ? AND actor_id = ? AND status = 'paused'").bind(Date.now(), id, actorId).run();
  return getAiJob(env, actorId, id);
}

/** A leased invocation can run from a foreground connection or the independent cron dispatcher. */
export async function runAiJob(env: AiWorkerEnv, actorId: string, id: string, origin: string, budgetMs = 600_000): Promise<void> {
  const { row, state } = await load(env, id, actorId);
  const runner = crypto.randomUUID();
  const now = Date.now();
  await env.DB!.prepare("UPDATE ai_tracking_jobs SET status = 'running', runner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND actor_id = ? AND (status = 'queued' OR (status = 'running' AND lease_until < ?))")
    .bind(runner, now + LEASE_MS, now, id, actorId, now).run();
  const owned = await env.DB!.prepare('SELECT runner FROM ai_tracking_jobs WHERE id = ?').bind(id).first<{ runner: string | null }>();
  if (owned?.runner !== runner) return;
  const abort = new AbortController();
  localRunners.set(id, abort);
  let yielded = false;
  let storageError: unknown;
  let writes: Promise<void> = Promise.resolve();
  const persist = async (status: JobStatus = 'running') => {
    const payload = await encodeAiJobPayload(env, id, state);
    await env.DB!.prepare("UPDATE ai_tracking_jobs SET payload = ?, status = ?, updated_at = ?, lease_until = ? WHERE id = ? AND runner = ? AND status = 'running'")
      .bind(payload, status, Date.now(), Date.now() + LEASE_MS, id, runner).run();
  };
  const enqueue = (task: () => Promise<void>) => {
    writes = writes.then(task).catch((error: unknown) => { storageError = error; abort.abort(error); });
    return writes;
  };
  const timer = setTimeout(() => { yielded = true; abort.abort(new Error('后台任务已保存检查点，等待继续执行')); }, budgetMs);
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      const current = await env.DB!.prepare('SELECT status, runner FROM ai_tracking_jobs WHERE id = ?').bind(id).first<{ status: JobStatus; runner: string | null }>();
      if (current?.status !== 'running' || current.runner !== runner) { abort.abort(new Error('任务已停止或执行权已转移')); return; }
      await env.DB!.prepare("UPDATE ai_tracking_jobs SET lease_until = ? WHERE id = ? AND runner = ? AND status = 'running'").bind(Date.now() + LEASE_MS, id, runner).run();
    })().catch((error: unknown) => { storageError = error; abort.abort(error); }).finally(() => { checking = false; });
  }, 5_000);
  const jobFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal });
  try {
    const response = await generateAiDraft(env, row.record_id, state.input, actorId, origin, jobFetch,
      (progress: AiTrackingGenerationProgress) => {
        state.progress.push({ ...progress, elapsedMs: Date.now() - row.created_at });
        void enqueue(() => persist());
      }, abort.signal, {
        get: (key: string) => state.cache[key],
        put: async (key: string, value: unknown) => { state.cache[key] = value; await enqueue(() => persist()); if (storageError) throw storageError; },
      });
    abort.signal.throwIfAborted();
    state.draftId = response.draft.id;
    await enqueue(() => persist('completed'));
  } catch (error) {
    await writes;
    if (storageError) throw storageError;
    if (yielded) {
      await persist('queued');
    } else if (!abort.signal.aborted) {
      state.error = error instanceof Error ? error.message : '后台生成失败';
      await persist('failed');
    }
    // Explicit cancellation remains terminal; conditional writes cannot overwrite it.
  } finally {
    clearTimeout(timer); clearInterval(heartbeat);
    if (localRunners.get(id) === abort) localRunners.delete(id);
  }
}

export async function dispatchAiJobs(env: AiWorkerEnv, origin: string): Promise<{ processed: number }> {
  await schema(env);
  const rows = await env.DB!.prepare("SELECT * FROM ai_tracking_jobs WHERE status = 'queued' OR (status = 'running' AND lease_until < ?) ORDER BY created_at LIMIT 1").bind(Date.now()).all<JobRow>();
  // Cron has a four-minute request ceiling. Persist model checkpoints and yield before it.
  for (const row of rows.results || []) await runAiJob(env, row.actor_id, row.id, origin, 200_000);
  return { processed: rows.results?.length || 0 };
}

export async function getAiJobResult(env: AiWorkerEnv, actorId: string, id: string) {
  const { job } = await getAiJob(env, actorId, id);
  return job.draftId ? getAiDraft(env, actorId, job.recordId, job.draftId) : { draft: null };
}
