import { createAiJob, getAiJob, cancelAiJob, pauseAiJob, resumeAiJob, runAiJob, dispatchAiJobs } from '../../worker/ai-jobs';
import { generateAiDraft, type AiWorkerEnv, type D1Database, type D1PreparedStatement } from '../../worker/ai-tracking';

jest.mock('../../worker/ai-tracking', () => ({
  getAiConfigStatus: () => ({ configured: true }),
  generateAiDraft: jest.fn(), getAiDraft: jest.fn(),
  encodeAiJobPayload: async (_env: unknown, _id: string, value: unknown) => JSON.stringify(value),
  decodeAiJobPayload: async (_env: unknown, value: string) => JSON.parse(value),
}));
jest.mock('../../worker/tracking-read', () => ({ getTrackingDetail: async () => ({ data: { permissions: { canEditDesign: true } } }) }));
type Row = Record<string, unknown>;
class MemoryDb implements D1Database {
  rows: Map<string, Row> = new Map();
  prepare(sql: string): D1PreparedStatement {
    let values: unknown[] = [];
    const matches = (): Row[] => {
      if (sql.includes('WHERE id = ?')) {
        const row = this.rows.get(String(values[0]));
        return row && (!sql.includes('AND actor_id = ?') || row.actor_id === values[1]) ? [row] : [];
      }
      return [...this.rows.values()].filter((row: Row) => {
        if (sql.includes('WHERE actor_id = ?')) {
          return row.actor_id === values[0] && (!sql.includes('record_id = ?') || row.record_id === values[1])
            && (!sql.includes("status IN ('queued', 'running', 'paused')") || ['queued', 'running', 'paused'].includes(String(row.status)));
        }
        return row.status === 'queued' || row.status === 'running' && Number(row.lease_until) < Number(values[0]);
      }).reverse();
    };
    const statement: D1PreparedStatement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async <T>() => (matches()[0] || null) as T | null,
      all: async <T>() => ({ results: matches() as T[] }),
      run: async () => {
        if (sql.startsWith('CREATE')) return {};
        if (sql.startsWith('INSERT')) {
          if ([...this.rows.values()].some((row: Row) => row.actor_id === values[1] && row.record_id === values[2] && ['queued', 'running', 'paused'].includes(String(row.status)))) return {};
          this.rows.set(String(values[0]), { id: values[0], actor_id: values[1], record_id: values[2], status: 'queued', created_at: values[3], updated_at: values[4], payload: values[5], runner: null, lease_until: 0 });
        } else if (sql.includes("SET status = 'running'")) {
          const row = this.rows.get(String(values[3]));
          if (row && row.actor_id === values[4] && (row.status === 'queued' || row.status === 'running' && Number(row.lease_until) < Number(values[5]))) Object.assign(row, { status: 'running', runner: values[0], lease_until: values[1], updated_at: values[2] });
        } else if (sql.includes("SET status = 'cancelled'")) {
          const row = this.rows.get(String(values[1]));
          if (row && row.actor_id === values[2] && ['queued', 'running', 'paused'].includes(String(row.status))) Object.assign(row, { status: 'cancelled', updated_at: values[0], lease_until: 0 });
        } else if (sql.includes("SET status = 'paused'") || sql.includes("SET status = 'queued'")) {
          const row = this.rows.get(String(values[1]));
          if (row && row.actor_id === values[2]) {
            if (sql.includes("SET status = 'paused'") && ['queued', 'running'].includes(String(row.status))) Object.assign(row, { status: 'paused', updated_at: values[0], lease_until: 0 });
            if (sql.includes("SET status = 'queued'") && row.status === 'paused') Object.assign(row, { status: 'queued', updated_at: values[0], lease_until: 0 });
          }
        } else if (sql.includes('SET payload')) {
          const row = this.rows.get(String(values[4]));
          if (row?.status === 'running' && row.runner === values[5]) Object.assign(row, { payload: values[0], status: values[1], updated_at: values[2], lease_until: values[3] });
        } else if (sql.includes('SET lease_until')) {
          const row = this.rows.get(String(values[1]));
          if (row?.status === 'running' && row.runner === values[2]) row.lease_until = values[0];
        }
        return {};
      },
    };
    return statement;
  }
}
const model = jest.mocked(generateAiDraft);
const fixture = () => ({ DB: new MemoryDb() } as AiWorkerEnv & { DB: MemoryDb });

describe('persistent AI jobs', () => {
  afterEach(() => { jest.useRealTimers(); model.mockReset(); });
  it('deduplicates active jobs and scopes reads and cancellation to the owner', async () => {
    const env = fixture();
    const first = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    const second = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    expect(second.job.id).toBe(first.job.id);
    await expect(getAiJob(env, 'other', first.job.id)).rejects.toThrow('无权访问');
    await expect(cancelAiJob(env, 'other', first.job.id)).rejects.toThrow('无权访问');
    expect((await cancelAiJob(env, 'owner', first.job.id)).job.status).toBe('cancelled');
    expect((await createAiJob(env, 'owner', 'web:rec', {}, 'https://example')).job.id).not.toBe(first.job.id);
  });
  it('uses a lease to prevent double execution, and cancellation cannot be overwritten by late success', async () => {
    const env = fixture();
    const { job } = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    let complete!: (value: { draft: { id: string } }) => void;
    model.mockImplementation(async () => new Promise((resolve) => { complete = resolve as typeof complete; }));
    const active = runAiJob(env, 'owner', job.id, 'https://example');
    while (!complete) await new Promise((resolve) => setImmediate(resolve));
    await runAiJob(env, 'owner', job.id, 'https://example');
    expect(model).toHaveBeenCalledTimes(1);
    await cancelAiJob(env, 'owner', job.id);
    complete({ draft: { id: 'late-draft' } });
    await active;
    expect((await getAiJob(env, 'owner', job.id)).job.status).toBe('cancelled');
  });
  it('persists progress and model checkpoints before the terminal result', async () => {
    const env = fixture();
    const { job } = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    model.mockImplementation(async (...args) => {
      args[6]?.({ stage: 'planning', message: '规划中' });
      await args[8]?.put('model-key', { events: [] });
      expect(args[8]?.get('model-key')).toEqual({ events: [] });
      return { draft: { id: 'draft-1' } } as never;
    });
    await runAiJob(env, 'owner', job.id, 'https://example');
    const saved = (await getAiJob(env, 'owner', job.id)).job;
    expect(saved.status).toBe('completed');
    expect(saved.progress[0].stage).toBe('planning');
    expect(saved.draftId).toBe('draft-1');
  });
  it('lets the independent dispatcher claim queued work without a browser', async () => {
    const env = fixture();
    const { job } = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    model.mockResolvedValue({ draft: { id: 'cron-draft' } } as never);
    await expect(dispatchAiJobs(env, 'https://example')).resolves.toEqual({ processed: 1 });
    expect((await getAiJob(env, 'owner', job.id)).job.status).toBe('completed');
  });
});

describe('AI job recovery', () => {
  afterEach(() => model.mockReset());
  it('yields with saved checkpoints and resumes without losing model results', async () => {
    const env = fixture();
    const { job } = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    model.mockImplementationOnce(async (...args) => {
      await args[8]!.put('done-batch', { events: [{ evtId: 'sub_result' }] });
      await new Promise<void>((_resolve, reject) => args[7]!.addEventListener('abort', () => reject(args[7]!.reason), { once: true }));
      throw new Error('unreachable');
    });
    await runAiJob(env, 'owner', job.id, 'https://example', 20);
    expect((await getAiJob(env, 'owner', job.id)).job.status).toBe('queued');
    model.mockImplementationOnce(async (...args) => {
      expect(args[8]!.get('done-batch')).toEqual({ events: [{ evtId: 'sub_result' }] });
      return { draft: { id: 'resumed' } } as never;
    });
    await runAiJob(env, 'owner', job.id, 'https://example');
    expect((await getAiJob(env, 'owner', job.id)).job.status).toBe('completed');
  });
  it('recovers a dead invocation lease and never dispatches a manually stopped job', async () => {
    const env = fixture();
    const { job } = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    Object.assign(env.DB.rows.get(job.id)!, { status: 'running', runner: 'dead', lease_until: 0 });
    model.mockResolvedValue({ draft: { id: 'recovered' } } as never);
    await dispatchAiJobs(env, 'https://example');
    expect((await getAiJob(env, 'owner', job.id)).job.status).toBe('completed');
    const next = await createAiJob(env, 'owner', 'web:rec', {}, 'https://example');
    await cancelAiJob(env, 'owner', next.job.id);
    expect((await dispatchAiJobs(env, 'https://example')).processed).toBe(0);
  });
});

 it('pauses without dispatching, resumes from the same job, and permits cancelling paused work', async () => {
    const env = fixture();
    const { job } = await createAiJob(env, 'owner', 'web:paused', {}, 'https://example');
    expect((await pauseAiJob(env, 'owner', job.id)).job.status).toBe('paused');
    expect((await createAiJob(env, 'owner', 'web:paused', {}, 'https://example')).job.id).toBe(job.id);
    expect((await dispatchAiJobs(env, 'https://example')).processed).toBe(0);
    expect((await resumeAiJob(env, 'owner', job.id)).job.status).toBe('queued');
    await pauseAiJob(env, 'owner', job.id);
    expect((await cancelAiJob(env, 'owner', job.id)).job.status).toBe('cancelled');
  });
