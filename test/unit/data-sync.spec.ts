import { webcrypto } from 'node:crypto';
import { database } from './sqlite-d1.fixture';
import { ensureRecordStore, storeMode, D1RecordStore } from '../../worker/d1-record-store';
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

});
