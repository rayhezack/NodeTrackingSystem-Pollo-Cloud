import { webcrypto } from 'node:crypto';
import { database } from './sqlite-d1.fixture';
import { D1RecordStore, ensureRecordStore, type AtomicDatabase } from '../../worker/d1-record-store';
import { applyOfficialParamGovernance } from '../../worker/official-param-governance';
import worker from '../../worker/index';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-11-25T08:00:00Z');
const admin = { name: '测试管理员' };

async function library(): Promise<AtomicDatabase> {
  const db = database();
  await ensureRecordStore(db);
  const store = new D1RecordStore(db);
  await store.create('officialParamDetail', [
    { evt_id: 'createflow_start', 参数名: 'createflow_id', 数据类型: 'UNKNOWN', 必传规则: '', 参数定义: '创作流 ID', 参数状态: '正式' },
    { evt_id: 'content_expose', 参数名: 'page_name', 数据类型: 'STRING', 必传规则: '必传', 条件说明: [{ type: 'text', text: '' }], 参数状态: '正式' },
    { evt_id: 'old_event', 参数名: 'old_param', 数据类型: 'STRING', 必传规则: '必传', 参数状态: '已废弃' },
    { evt_id: 'dup_event', 参数名: 'dup_param', 数据类型: 'STRING', 必传规则: '必传', 参数状态: '正式' },
    { evt_id: 'dup_event', 参数名: 'dup_param', 数据类型: 'STRING', 必传规则: '必传', 参数状态: '正式' },
  ]);
  await store.create('webOfficialParamDetail', [{ evt_id: 'banner_expose', 参数名: 'widget_name', 数据类型: 'UNKNOWN', 必传规则: '必传', 参数状态: '正式' }]);
  await store.commit();
  return db;
}

async function outboxCount(db: AtomicDatabase): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS count FROM tracking_sync_outbox').first<{ count: number }>())!.count;
}

async function param(db: AtomicDatabase, instance: string, evtId: string, name: string) {
  const page = await new D1RecordStore(db).search(instance, { filter: { conjunction: 'and', conditions: [
    { field_name: 'evt_id', operator: 'is', value: [evtId] }, { field_name: '参数名', operator: 'is', value: [name] },
  ] } });
  return page.records[0].record;
}

describe('official parameter governance', () => {
  it('previews by default and writes nothing', async () => {
    const db = await library();
    const before = await outboxCount(db);
    const store = new D1RecordStore(db);
    const preview = await applyOfficialParamGovernance({ LOCAL_STORE: store }, {
      source: 'app', items: [{ evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'STRING', requiredRule: '必传', note: '7 天日志 100% 上报，均为字符串' }],
    }, admin, NOW);
    await store.commit();
    expect(preview.dryRun).toBe(true);
    expect(preview.changes).toEqual([{
      evtId: 'createflow_start', paramName: 'createflow_id', recordId: expect.any(String),
      before: { dataType: 'UNKNOWN', requiredRule: '', condition: '' }, after: { dataType: 'STRING', requiredRule: '必传', condition: '' },
      note: '2026-11-25 测试管理员 正式参数治理：类型 UNKNOWN→STRING，必传 空→必传。7 天日志 100% 上报，均为字符串',
    }]);
    expect(await outboxCount(db)).toBe(before);
    expect((await param(db, 'officialParamDetail', 'createflow_start', 'createflow_id'))['数据类型']).toBe('UNKNOWN');
  });

  it('writes only type, required rule and condition, and queues a minimal Base patch', async () => {
    const db = await library();
    const before = await outboxCount(db);
    const store = new D1RecordStore(db);
    const result = await applyOfficialParamGovernance({ LOCAL_STORE: store }, {
      source: 'app', dryRun: false, items: [
        { evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'STRING', requiredRule: '必传', note: '日志 100% 上报' },
        { evtId: 'content_expose', paramName: 'page_name', requiredRule: '条件必传', condition: '仅在 Feed 页曝光时上报', note: '日志 55% 上报' },
      ],
    }, admin, NOW);
    await store.commit();
    expect(result.changes).toHaveLength(2);
    const first = await param(db, 'officialParamDetail', 'createflow_start', 'createflow_id');
    expect(first).toMatchObject({ 数据类型: 'STRING', 必传规则: '必传', 参数定义: '创作流 ID' });
    const second = await param(db, 'officialParamDetail', 'content_expose', 'page_name');
    expect(second).toMatchObject({ 必传规则: '条件必传', 条件说明: '仅在 Feed 页曝光时上报', 数据类型: 'STRING' });
    expect(await outboxCount(db)).toBe(before + 2);
    const jobs = await db.prepare('SELECT payload FROM tracking_sync_outbox ORDER BY id DESC LIMIT 2').all<{ payload: string }>();
    expect(jobs.results.map((job) => JSON.parse(job.payload))).toEqual(expect.arrayContaining([
      { 数据类型: 'STRING', 必传规则: '必传' },
      { 必传规则: '条件必传', 条件说明: '仅在 Feed 页曝光时上报' },
    ]));
  });

  it('targets the Web parameter table by source and reports unchanged items', async () => {
    const db = await library();
    const store = new D1RecordStore(db);
    const result = await applyOfficialParamGovernance({ LOCAL_STORE: store }, {
      source: 'web', dryRun: false, items: [{ evtId: 'banner_expose', paramName: 'widget_name', dataType: 'STRING', requiredRule: '必传', note: '日志均为字符串' }],
    }, admin, NOW);
    await store.commit();
    expect(result.changes[0].note).toContain('类型 UNKNOWN→STRING');
    expect((await param(db, 'webOfficialParamDetail', 'banner_expose', 'widget_name'))['数据类型']).toBe('STRING');
    const again = await applyOfficialParamGovernance({ LOCAL_STORE: new D1RecordStore(db) }, {
      source: 'web', items: [{ evtId: 'banner_expose', paramName: 'widget_name', dataType: 'STRING', note: '复查' }],
    }, admin, NOW);
    expect(again.unchanged).toEqual(['banner_expose.widget_name']);
  });

  it('rejects the whole batch on any problem, so nothing is half-applied', async () => {
    const db = await library();
    const before = await outboxCount(db);
    const run = (body: unknown) => applyOfficialParamGovernance({ LOCAL_STORE: new D1RecordStore(db) }, body, admin, NOW);
    await expect(run({ source: 'app', dryRun: false, items: [
      { evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'STRING', note: '日志' },
      { evtId: 'missing', paramName: 'x', dataType: 'STRING', note: '日志' },
      { evtId: 'dup_event', paramName: 'dup_param', dataType: 'STRING', note: '日志' },
      { evtId: 'old_event', paramName: 'old_param', dataType: 'INTEGER', note: '日志' },
      { evtId: 'content_expose', paramName: 'page_name', requiredRule: '条件必传', note: '日志' },
    ] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/找不到：missing\.x[\s\S]*重复，需先治理：dup_event\.dup_param[\s\S]*old_event\.old_param 已废弃[\s\S]*需要填写条件说明/) });
    await expect(run({ source: 'app', items: [{ evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'UNKNOWN', note: 'x' }] })).rejects.toThrow('数据类型只能是');
    await expect(run({ source: 'app', items: [{ evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'BOOLEAN', note: 'x' }] })).rejects.toThrow('数据类型只能是');
    await expect(run({ source: 'app', items: [{ evtId: 'createflow_start', paramName: 'createflow_id', requiredRule: '必填', note: 'x' }] })).rejects.toThrow('必传规则只能是');
    await expect(run({ source: 'app', items: [{ evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'STRING', note: '' }] })).rejects.toThrow('缺少原因说明');
    await expect(run({ source: 'app', items: [{ evtId: 'createflow_start', paramName: 'createflow_id', note: '只写原因' }] })).rejects.toThrow('至少要改');
    await expect(run({ source: 'app', items: [
      { evtId: 'a', paramName: 'b', dataType: 'STRING', note: 'x' }, { evtId: 'a', paramName: 'b', dataType: 'STRING', note: 'x' },
    ] })).rejects.toThrow('重复');
    expect(await outboxCount(db)).toBe(before);
    expect((await param(db, 'officialParamDetail', 'createflow_start', 'createflow_id'))['数据类型']).toBe('UNKNOWN');
  });

  it('refuses to run outside the D1 primary store', async () => {
    await expect(applyOfficialParamGovernance({}, { source: 'app', items: [] }, admin)).rejects.toMatchObject({ status: 409 });
  });

  it('only lets admins call the parameter route', async () => {
    const db = await library();
    await db.prepare("INSERT INTO tracking_store_meta(key,value) VALUES('mode','d1') ON CONFLICT(key) DO UPDATE SET value='d1'").run();
    const seed = new D1RecordStore(db);
    await seed.create('workbench', [{ evt_id: '__system_permissions__', 需求背景: JSON.stringify({ admins: ['admin-user'] }) }]);
    await seed.commit();
    await db.prepare('CREATE TABLE IF NOT EXISTS pollocloud_feishu_identity (platform_user_id TEXT PRIMARY KEY, feishu_user_id TEXT NOT NULL, name TEXT NOT NULL, feishu_open_id TEXT, email TEXT, updated_at INTEGER NOT NULL)').run();
    for (const [platformId, userId] of [['p-admin', 'admin-user'], ['p-viewer', 'viewer-user']]) {
      await db.prepare('INSERT INTO pollocloud_feishu_identity(platform_user_id,feishu_user_id,name,updated_at) VALUES(?,?,?,?)').bind(platformId, userId, userId, Date.now()).run();
    }
    const call = (platformId: string) => worker.fetch(new Request('https://app.test/api/query-library/param-governance', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pollocloud-user-id': platformId, 'x-pollocloud-user-name': platformId },
      body: JSON.stringify({ source: 'app', dryRun: false, items: [{ evtId: 'createflow_start', paramName: 'createflow_id', dataType: 'STRING', note: '日志' }] }),
    }), { DB: db, TRACKING_D1_ENABLED: '1' } as never);
    expect((await call('p-viewer')).status).toBe(403);
    expect((await param(db, 'officialParamDetail', 'createflow_start', 'createflow_id'))['数据类型']).toBe('UNKNOWN');
    expect((await call('p-admin')).status).toBe(200);
    expect((await param(db, 'officialParamDetail', 'createflow_start', 'createflow_id'))['数据类型']).toBe('STRING');
  });
});
