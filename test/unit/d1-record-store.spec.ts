import { database } from './sqlite-d1.fixture';
import { webcrypto } from 'node:crypto';
import { D1RecordStore, ensureRecordStore } from '../../worker/d1-record-store';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('D1 authoritative record store using real SQLite transactions', () => {
  it('saves data and outbox atomically, with read-your-writes and query filtering', async () => {
    const db = database(); await ensureRecordStore(db);
    const store = new D1RecordStore(db);
    const [row] = await store.create('webWorkbench', [{ 需求ID: 'request1', evt_id: 'event1', 关联设计: ['parent'] }]);
    expect((await store.get('webWorkbench', row.id))?.record.evt_id).toBe('event1');
    const filter = { conjunction: 'and' as const, conditions: [{ field_name: '需求ID', operator: 'is', value: ['request1'] }] };
    expect((await store.search('webWorkbench', { filter })).total).toBe(1);
    await store.commit();
    const next = new D1RecordStore(db);
    expect((await next.search('webWorkbench', { filter })).total).toBe(1);
    expect((await next.search('webWorkbench', { filter: { conjunction: 'and', conditions: [{ field_name: '关联设计', operator: 'contains', value: ['parent'] }] } })).total).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM tracking_sync_outbox').first<{ count: number }>())?.count).toBe(1);
  });
  it('rejects an overlapping transaction without overwriting or adding phantom sync jobs', async () => {
    const db = database(); await ensureRecordStore(db);
    const first = new D1RecordStore(db); const [row] = await first.create('webWorkbench', [{ evt_id: 'event' }]); await first.commit();
    const left = new D1RecordStore(db), right = new D1RecordStore(db);
    await left.update('webWorkbench', [{ id: row.id, record: { 事件中文名: 'left' } }]);
    await right.update('webWorkbench', [{ id: row.id, record: { 事件中文名: 'right' } }]);
    await left.commit();
    await expect(right.commit()).rejects.toThrow();
    expect((await new D1RecordStore(db).get('webWorkbench', row.id))?.record['事件中文名']).toBe('left');
    expect((await db.prepare('SELECT COUNT(*) AS count FROM tracking_sync_outbox').first<{ count: number }>())?.count).toBe(2);
  });
  it('preserves unrelated fields locally but only exports the changed fields', async () => {
    const db = database(); await ensureRecordStore(db);
    await db.prepare('INSERT INTO tracking_rows(instance,id,fields) VALUES(?,?,?)').bind('webWorkbench', 'base-id', JSON.stringify({ 创建时间: 10, evt_id: 'event', 事件中文名: 'before' })).run();
    const store = new D1RecordStore(db);
    await store.update('webWorkbench', [{ id: 'base-id', record: { 事件中文名: 'after' } }]);
    await store.commit();
    expect((await new D1RecordStore(db).get('webWorkbench', 'base-id'))?.record['创建时间']).toBe(10);
    expect(JSON.parse((await db.prepare('SELECT payload FROM tracking_sync_outbox').first<{ payload: string }>())!.payload)).toEqual({ 事件中文名: 'after' });
  });
  it('does not commit anything when a business operation fails before commit', async () => {
    const db = database(); await ensureRecordStore(db);
    const aborted = new D1RecordStore(db); await aborted.create('webWorkbench', [{ evt_id: 'not-committed' }]);
    expect((await new D1RecordStore(db).search('webWorkbench', {})).total).toBe(0);
  });
  it('finds migrated Base rich text and link objects, including mixed original and edited scalar cells', async () => {
    const db = database(); await ensureRecordStore(db);
    const original = {需求ID:[{type:'text',text:'req'}],evt_id:[{type:'text',text:'event'}],关联设计:{link_record_ids:['parent']}};
    await db.prepare('INSERT INTO tracking_rows(instance,id,fields) VALUES(?,?,?)').bind('webWorkbench','original',JSON.stringify(original)).run();
    const store = new D1RecordStore(db);
    const filter = {conjunction:'and' as const,conditions:[{field_name:'需求ID',operator:'is',value:['req']}]};
    expect((await store.search('webWorkbench',{filter})).records.map((row)=>row.id)).toEqual(['original']);
    expect((await store.search('webWorkbench',{filter:{conjunction:'and',conditions:[{field_name:'关联设计',operator:'contains',value:['parent']}]}})).total).toBe(1);
    await store.update('webWorkbench',[{id:'original',record:{evt_id:'edited'}}]);
    expect((await store.search('webWorkbench',{filter})).records[0].record.evt_id).toBe('edited');
    await store.commit();
    expect((await new D1RecordStore(db).search('webWorkbench',{filter})).total).toBe(1);
  });

});
