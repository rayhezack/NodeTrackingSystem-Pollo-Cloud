import { webcrypto } from 'node:crypto';
import { database } from './sqlite-d1.fixture';
import { D1RecordStore, ensureRecordStore, type AtomicDatabase } from '../../worker/d1-record-store';
import { applyOfficialGovernance } from '../../worker/official-governance';
import worker from '../../worker/index';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const NOW = new Date('2026-11-24T08:00:00Z');

async function library(): Promise<AtomicDatabase> {
  const db = database();
  await ensureRecordStore(db);
  const store = new D1RecordStore(db);
  await store.create('queryLibrary', [
    { evt_id: 'agent_type_expo', 状态: '已上线', 生命周期状态: '埋点设计', 最近评审记录: [{ type: 'text', text: '旧记录第一行\n第二行' }] },
    { evt_id: 'quick_links_expo', 状态: '已上线', 生命周期状态: '埋点设计' },
    { evt_id: 'old_event', 状态: '已废弃', 生命周期状态: '稳定归档' },
    { evt_id: 'dup_event', 状态: '已上线' },
    { evt_id: 'dup_event', 状态: '已上线' },
  ]);
  await store.create('webQueryLibrary', [{ evt_id: 'agent_session_view', 状态: '已上线' }]);
  await store.commit();
  return db;
}

async function outboxCount(db: AtomicDatabase): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS count FROM tracking_sync_outbox').first<{ count: number }>())!.count;
}

async function eventRecord(db: AtomicDatabase, instance: string, evtId: string) {
  const page = await new D1RecordStore(db).search(instance, { filter: { conjunction: 'and', conditions: [{ field_name: 'evt_id', operator: 'is', value: [evtId] }] } });
  return page.records[0];
}

describe('official library governance', () => {
  it('previews by default and writes nothing until dryRun is explicitly false', async () => {
    const db = await library();
    const before = await outboxCount(db);
    const store = new D1RecordStore(db);
    const preview = await applyOfficialGovernance({ LOCAL_STORE: store }, {
      source: 'app', items: [{ evtId: 'agent_type_expo', status: '待治理', note: '11/18 起两端停报' }],
    }, { name: '测试管理员' }, NOW);
    await store.commit();
    expect(preview.dryRun).toBe(true);
    expect(preview.changes).toEqual([{
      evtId: 'agent_type_expo', recordId: expect.any(String),
      before: { status: '已上线', lifecycleStatus: '埋点设计' }, after: { status: '待治理', lifecycleStatus: '埋点设计' },
      reviewNote: '2026-11-24 测试管理员 正式库治理：状态 已上线→待治理。11/18 起两端停报',
    }]);
    expect(await outboxCount(db)).toBe(before);
    expect((await eventRecord(db, 'queryLibrary', 'agent_type_expo')).record['状态']).toBe('已上线');
  });

  it('writes only status, lifecycle and the review note, keeps earlier review history, and queues a minimal Base patch', async () => {
    const db = await library();
    const before = await outboxCount(db);
    const store = new D1RecordStore(db);
    const result = await applyOfficialGovernance({ LOCAL_STORE: store }, {
      source: 'app', dryRun: false, items: [
        { evtId: 'agent_type_expo', status: '待治理', note: '11/18 起两端停报' },
        { evtId: 'quick_links_expo', status: '已上线', note: '在报，无需改动' },
      ],
    }, { name: '测试管理员' }, NOW);
    await store.commit();
    expect(result.unchanged).toEqual(['quick_links_expo']);
    const record = (await eventRecord(db, 'queryLibrary', 'agent_type_expo')).record;
    expect(record['状态']).toBe('待治理');
    expect(record['生命周期状态']).toBe('埋点设计');
    expect(record['最近评审记录']).toBe('2026-11-24 测试管理员 正式库治理：状态 已上线→待治理。11/18 起两端停报\n旧记录第一行\n第二行');
    expect(await outboxCount(db)).toBe(before + 1);
    const job = await db.prepare('SELECT instance, payload FROM tracking_sync_outbox ORDER BY id DESC LIMIT 1').first<{ instance: string; payload: string }>();
    expect(job?.instance).toBe('queryLibrary');
    expect(Object.keys(JSON.parse(job!.payload)).sort()).toEqual(['最近评审记录', '状态'].sort());
  });

  it('describes an empty lifecycle and targets the Web library by source', async () => {
    const db = await library();
    const store = new D1RecordStore(db);
    const result = await applyOfficialGovernance({ LOCAL_STORE: store }, {
      source: 'web', dryRun: false, items: [{ evtId: 'agent_session_view', lifecycleStatus: '稳定归档', note: '近 30 天每天上报' }],
    }, { name: '测试管理员' }, NOW);
    await store.commit();
    expect(result.changes[0].reviewNote).toContain('生命周期 空→稳定归档');
    expect((await eventRecord(db, 'webQueryLibrary', 'agent_session_view')).record['生命周期状态']).toBe('稳定归档');
  });

  it('rejects the whole batch on any problem, so nothing is half-applied', async () => {
    const db = await library();
    const before = await outboxCount(db);
    const run = (body: unknown) => applyOfficialGovernance({ LOCAL_STORE: new D1RecordStore(db) }, body, { name: '测试管理员' }, NOW);
    await expect(run({ source: 'app', dryRun: false, items: [
      { evtId: 'agent_type_expo', status: '待治理', note: '停报' },
      { evtId: 'missing_event', status: '待治理', note: '停报' },
      { evtId: 'dup_event', status: '待治理', note: '停报' },
      { evtId: 'old_event', status: '待治理', note: '停报' },
    ] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/找不到事件：missing_event[\s\S]*重复事件，需先治理：dup_event[\s\S]*old_event 已废弃，请通过废弃需求单处理/) });
    await expect(run({ source: 'app', items: [{ evtId: 'agent_type_expo', status: '已废弃', note: '下线' }] })).rejects.toThrow('废弃请走废弃需求单');
    await expect(run({ source: 'app', items: [{ evtId: 'agent_type_expo', status: '待治理', note: ' ' }] })).rejects.toThrow('缺少原因说明');
    await expect(run({ source: 'app', items: [{ evtId: 'agent_type_expo', note: '只写原因' }] })).rejects.toThrow('至少要改状态或生命周期状态之一');
    await expect(run({ source: 'app', items: [{ evtId: 'a', status: '待治理', note: 'x' }, { evtId: 'a', status: '待治理', note: 'x' }] })).rejects.toThrow('重复：a');
    await expect(run({ source: 'ios', items: [] })).rejects.toThrow(/source 必须是 web 或 app[\s\S]*items 不能为空/);
    expect(await outboxCount(db)).toBe(before);
    expect((await eventRecord(db, 'queryLibrary', 'agent_type_expo')).record['状态']).toBe('已上线');
  });

  it('refuses to run outside the D1 primary store', async () => {
    await expect(applyOfficialGovernance({}, { source: 'app', items: [] }, { name: '测试管理员' })).rejects.toMatchObject({ status: 409 });
  });

  it('only lets admins call the route, and commits an admin change through the D1 request wrapper', async () => {
    const db = await library();
    await db.prepare("INSERT INTO tracking_store_meta(key,value) VALUES('mode','d1') ON CONFLICT(key) DO UPDATE SET value='d1'").run();
    const seed = new D1RecordStore(db);
    await seed.create('workbench', [{ evt_id: '__system_permissions__', 需求背景: JSON.stringify({ admins: ['admin-user'] }) }]);
    await seed.commit();
    await db.prepare('CREATE TABLE IF NOT EXISTS pollocloud_feishu_identity (platform_user_id TEXT PRIMARY KEY, feishu_user_id TEXT NOT NULL, name TEXT NOT NULL, feishu_open_id TEXT, email TEXT, updated_at INTEGER NOT NULL)').run();
    for (const [platformId, userId] of [['p-admin', 'admin-user'], ['p-viewer', 'viewer-user']]) {
      await db.prepare('INSERT INTO pollocloud_feishu_identity(platform_user_id,feishu_user_id,name,updated_at) VALUES(?,?,?,?)').bind(platformId, userId, userId, Date.now()).run();
    }
    const env = { DB: db, TRACKING_D1_ENABLED: '1' };
    const call = (platformId: string | null, method = 'POST') => worker.fetch(new Request('https://app.test/api/query-library/governance', {
      method, headers: { 'Content-Type': 'application/json', ...(platformId ? { 'x-pollocloud-user-id': platformId, 'x-pollocloud-user-name': platformId } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ source: 'app', dryRun: false, items: [{ evtId: 'agent_type_expo', status: '待治理', note: '11/18 起停报' }] }) } : {}),
    }), env as never);

    expect((await call(null)).status).toBe(401);
    expect((await call('p-viewer')).status).toBe(403);
    expect((await call('p-admin', 'GET')).status).toBe(405);
    expect((await eventRecord(db, 'queryLibrary', 'agent_type_expo')).record['状态']).toBe('已上线');
    const response = await call('p-admin');
    expect(response.status).toBe(200);
    expect((await eventRecord(db, 'queryLibrary', 'agent_type_expo')).record['状态']).toBe('待治理');
  });
});
