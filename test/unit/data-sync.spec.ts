import { webcrypto } from 'node:crypto';
import { database } from './sqlite-d1.fixture';
import { ensureRecordStore, storeMode, D1RecordStore } from '../../worker/d1-record-store';
import { startSyncRun, listSyncRuns, syncRunDetail } from '../../worker/sync-monitor';
import { importSyncPage, drainSync } from '../../worker/data-sync';
import { searchBitableRecordPage, createBitableRecords, updateBitableRecords } from '../../worker/feishu-bitable';
jest.mock('../../worker/feishu-bitable', () => ({ ...jest.requireActual('../../worker/feishu-bitable'), searchBitableRecordPage: jest.fn(), createBitableRecords: jest.fn(), updateBitableRecords: jest.fn() }));
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('D1 cutover and durable Base synchronization', () => {
  beforeEach(() => jest.clearAllMocks());
  it('keeps legacy reads until every table is imported, preserves IDs and resumes failed pages', async () => {
    const DB = database(); const env = { DB };
    jest.mocked(searchBitableRecordPage).mockImplementation(async (_env, instance) => ({ records: [{ id: `${instance}-base`, record: { evt_id: 'event', 关联事件: ['original-id'] } }], hasMore: false }));
    await importSyncPage(env);
    expect(await storeMode(DB)).toBe('importing');
    jest.mocked(searchBitableRecordPage).mockRejectedValueOnce(new Error('Base temporarily unavailable'));
    await expect(importSyncPage(env)).rejects.toThrow('temporarily unavailable');
    expect(await storeMode(DB)).toBe('importing');
    for (let index = 1; index < 16; index++) await importSyncPage(env);
    expect(await storeMode(DB)).toBe('d1');
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM tracking_rows').first<{n: number}>())?.n).toBe(16);
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM tracking_sync_outbox').first<{n: number}>())?.n).toBe(0);
    expect((await new D1RecordStore(DB).get('webWorkbench','webWorkbench-base'))?.record['关联事件']).toEqual(['original-id']);
    await expect(importSyncPage(env)).rejects.toThrow('禁止');
  });
  it('persists stable new IDs and maps related IDs before sending only the dirty patch', async () => {
    const DB = database(); await ensureRecordStore(DB);
    const store = new D1RecordStore(DB);
    const [parent] = await store.create('webWorkbench', [{ evt_id:'parent' }]);
    const [child] = await store.create('webParamDetail', [{ evt_id:'parent', 参数名:'entry', 关联设计:[parent.id] }]);
    await store.commit();
    jest.mocked(createBitableRecords).mockResolvedValueOnce([{id:'base-parent',record:{}}]).mockResolvedValueOnce([{id:'base-child',record:{}}]);
    await drainSync({DB});
    expect(jest.mocked(createBitableRecords).mock.calls[1][2][0]['关联设计']).toEqual(['base-parent']);
    expect((await new D1RecordStore(DB).get('webParamDetail', child.id))?.record['关联设计']).toEqual([parent.id]);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM tracking_sync_outbox WHERE status='synced'").first<{n:number}>())?.n).toBe(2);
    await drainSync({DB}); expect(createBitableRecords).toHaveBeenCalledTimes(2);
  });
  it('quarantines an uncertain create and never duplicates it on dispatch retry', async () => {
    const DB = database(); await ensureRecordStore(DB);
    const store = new D1RecordStore(DB); await store.create('webWorkbench',[{evt_id:'uncertain'}]); await store.commit();
    jest.mocked(createBitableRecords).mockRejectedValue(new Error('transport disconnected after create'));
    await drainSync({DB}); await drainSync({DB});
    expect(createBitableRecords).toHaveBeenCalledTimes(1);
    expect((await DB.prepare('SELECT status FROM tracking_sync_outbox').first<{status:string}>())?.status).toBe('processing');
  });
  it('retries a known-record update in order without overwriting a later change first', async () => {
    const DB = database(); await ensureRecordStore(DB);
    await DB.prepare('INSERT INTO tracking_rows(instance,id,fields) VALUES(?,?,?)').bind('webWorkbench','existing',JSON.stringify({evt_id:'event'})).run();
    await DB.prepare('INSERT INTO tracking_base_mapping(instance,local_id,base_id) VALUES(?,?,?)').bind('webWorkbench','existing','base-record').run();
    const first = new D1RecordStore(DB); await first.update('webWorkbench',[{id:'existing',record:{事件中文名:'one'}}]); await first.commit();
    const second = new D1RecordStore(DB); await second.update('webWorkbench',[{id:'existing',record:{事件中文名:'two'}}]); await second.commit();
    jest.mocked(updateBitableRecords).mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue([]);
    await drainSync({DB}); expect(updateBitableRecords).toHaveBeenCalledTimes(1);
    await drainSync({DB});
    expect(jest.mocked(updateBitableRecords).mock.calls.map((call)=>call[2][0].record)).toEqual([{事件中文名:'one'},{事件中文名:'one'},{事件中文名:'two'}]);
  });
  it('batches consecutive parameter creates and commits all mappings with acknowledgments', async () => {
    const DB = database(); await ensureRecordStore(DB);
    const store = new D1RecordStore(DB);
    await store.create('webParamDetail', [{参数名:'a'}, {参数名:'b'}]); await store.commit();
    jest.mocked(createBitableRecords).mockResolvedValue([{id:'recA',record:{}},{id:'recB',record:{}}]);
    expect(await drainSync({DB})).toEqual({processed:2});
    expect(createBitableRecords).toHaveBeenCalledTimes(1);
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM tracking_base_mapping').first<{n:number}>())?.n).toBe(2);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM tracking_sync_outbox WHERE status='synced'").first<{n:number}>())?.n).toBe(2);
  });

  it('resolves a circular parameter/dictionary dependency by allocating IDs before completing links', async () => {
    const DB = database(); await ensureRecordStore(DB);
    await DB.prepare("INSERT INTO tracking_sync_outbox(instance,record_id,payload,created_at) VALUES(?,?,?,?)").bind('webParamDetail','d1_param',JSON.stringify({evt_id:'event',参数名:'kind',枚举字典:['d1_enum']}),1).run();
    await DB.prepare("INSERT INTO tracking_sync_outbox(instance,record_id,payload,created_at) VALUES(?,?,?,?)").bind('webEnumDictionary','d1_enum',JSON.stringify({evt_id:'event',参数名:'kind',枚举值:'one',关联设计参数:['d1_param']}),2).run();
    jest.mocked(createBitableRecords).mockResolvedValueOnce([{id:'recParam',record:{}}]).mockResolvedValueOnce([{id:'recEnum',record:{}}]);
    jest.mocked(updateBitableRecords).mockImplementation(async (_env,_instance,records) => {
      expect((await DB.prepare('SELECT COUNT(*) AS n FROM tracking_base_mapping').first<{n:number}>())?.n).toBe(2);
      return records;
    });
    expect(await drainSync({DB})).toEqual({processed:2});
    expect(jest.mocked(createBitableRecords).mock.calls[0][2][0]).not.toHaveProperty('枚举字典');
    expect(jest.mocked(createBitableRecords).mock.calls[1][2][0]['关联设计参数']).toEqual(['recParam']);
    expect(jest.mocked(updateBitableRecords).mock.calls[0][2][0].record['枚举字典']).toEqual(['recEnum']);
    const run=(await listSyncRuns(DB))[0];expect(run.status).toBe('completed');expect(run.completed).toBe(2);
    const detail=await syncRunDetail(DB,run.id);expect(detail?.items.every(item=>item.status==='completed')).toBe(true);
  });
  it('persists a manual run, retains fixed totals across browser loss and records failures separately', async () => {
    const DB=database();await ensureRecordStore(DB);
    const store=new D1RecordStore(DB);await store.create('webParamDetail',[{evt_id:'event',参数名:'one'},{evt_id:'event',参数名:'two'}]);await store.commit();
    const id=await startSyncRun(DB,'manual');expect(await startSyncRun(DB,'manual')).toBe(id);
    jest.mocked(createBitableRecords).mockResolvedValueOnce([{id:'recOne',record:{}}]);
    await drainSync({DB},1);
    let run=(await listSyncRuns(DB)).find(item=>item.id===id)!;expect(run.total).toBe(2);expect(run.completed).toBe(1);expect(run.pending).toBe(1);
    jest.mocked(createBitableRecords).mockRejectedValueOnce(new Error('uncertain transport failure'));
    await drainSync({DB},1);
    run=(await listSyncRuns(DB)).find(item=>item.id===id)!;expect(run.status).toBe('blocked');expect(run.failed).toBe(1);expect(run.completed).toBe(1);
    const errors=await syncRunDetail(DB,id,0,'failed');expect(errors?.items).toHaveLength(1);expect(errors?.items[0].error).toContain('transport');
    expect((await syncRunDetail(DB,id,0,'completed'))?.totalItems).toBe(1);
    await expect(syncRunDetail(DB,id,-1)).rejects.toThrow('筛选');
  });
  it('does not create an orphan when a dependency job is missing', async () => {
    const DB=database();await ensureRecordStore(DB);
    const store=new D1RecordStore(DB);await store.create('webParamDetail',[{evt_id:'event',关联设计:['d1_missing']}]);await store.commit();
    await drainSync({DB});expect(createBitableRecords).not.toHaveBeenCalled();
    const run=(await listSyncRuns(DB))[0];expect(run.status).toBe('blocked');expect(run.completed).toBe(0);
  });

  it('groups queued/running and failed/blocked tasks without losing filtered pagination totals', async () => {
    const DB = database();
    await ensureRecordStore(DB);
    const store = new D1RecordStore(DB);
    await store.create('webParamDetail', Array.from({ length: 54 }, (_, index) => ({ 参数名: `parameter_${index}` })));
    await store.commit();
    const id = await startSyncRun(DB, 'manual');
    const jobs = (await DB.prepare('SELECT id FROM tracking_sync_outbox ORDER BY id').all<{ id: number }>()).results;
    await DB.batch(jobs.map((job, index) => DB.prepare('UPDATE tracking_sync_run_items SET status=? WHERE run_id=? AND job_id=?')
      .bind(index < 13 ? 'pending' : index < 27 ? 'running' : index < 36 ? 'failed' : index < 44 ? 'blocked' : 'completed', id, job.id)));
    const active = await syncRunDetail(DB, id, 0, 'active');
    expect(active?.totalItems).toBe(27);
    expect(active?.items).toHaveLength(25);
    expect(active?.items.every(item => ['pending', 'running'].includes(item.status))).toBe(true);
    expect((await syncRunDetail(DB, id, 1, 'active'))?.items).toHaveLength(2);
    const failed = await syncRunDetail(DB, id, 0, 'failed');
    expect(failed?.totalItems).toBe(17);
    expect(new Set(failed?.items.map(item => item.status))).toEqual(new Set(['failed', 'blocked']));
    const completed = await syncRunDetail(DB, id, 0, 'completed');
    expect(completed?.totalItems).toBe(10);
    expect((active?.totalItems || 0) + (failed?.totalItems || 0) + (completed?.totalItems || 0))
      .toBe((await syncRunDetail(DB, id))?.totalItems);
    await expect(syncRunDetail(DB, id, 0, 'invalid')).rejects.toThrow('筛选');
  });

});
