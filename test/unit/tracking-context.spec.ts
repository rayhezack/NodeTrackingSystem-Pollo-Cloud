import { webcrypto } from 'node:crypto';
import { database } from './sqlite-d1.fixture';
import { D1RecordStore, ensureRecordStore } from '../../worker/d1-record-store';
import { readTrackingContext } from '../../worker/tracking-context';
import { renderTrackingContext } from '../../shared/tracking-context-format';
import type {
  OfficialTrackingContextResponse,
  RequestTrackingContextResponse,
  SearchTrackingContextResponse,
} from '../../shared/api.interface';
import worker from '../../worker';
jest.mock('../../worker/pollocloud-identity', () => ({
  resolveCanonicalIdentity: jest.fn(async () => ({
    id: 'actor',
    name: 'Actor',
  })),
}));
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});

async function fixture() {
  const DB = database();
  await ensureRecordStore(DB);
  await DB.prepare(
    "INSERT INTO tracking_store_meta(key,value) VALUES('mode','d1')",
  ).run();
  const seed = async (
    instance: string,
    id: string,
    record: Record<string, unknown>,
  ) =>
    DB.prepare(
      'INSERT INTO tracking_rows(instance,id,fields) VALUES(?,?,?) ON CONFLICT(instance,id) DO UPDATE SET fields=excluded.fields',
    )
      .bind(instance, id, JSON.stringify(record))
      .run();
  await seed('webQueryLibrary', 'e1', {
    evt_id: [{ text: 'pay_result' }],
    事件中文名: '支付结果',
    事件定义: '业务结果',
    触发时机: '服务端结果',
    状态: '已上线',
    生命周期状态: '稳定归档',
    端: 'Web',
  });
  await seed('webQueryLibrary', 'e2', {
    evt_id: 'draft_event',
    事件中文名: '待开发事件',
    状态: '待开发',
    端: 'Web',
  });
  await seed('queryLibrary', 'ae1', {
    evt_id: 'pay_result',
    事件中文名: 'App结果',
    状态: '已上线',
    端: 'App',
  });
  await seed('webOfficialParamDetail', 'p1', {
    evt_id: [{ text: 'pay_result' }],
    参数名: 'result',
    参数主键: 'pay_result.result',
    数据类型: 'STRING',
    参数定义: '业务结果',
    必传规则: '必传',
    参数状态: '正式',
    关联事件: { link_record_ids: ['e1'] },
  });
  await seed('webCommonProperties', 'c1', {
    属性名: 'user_id',
    格式: 'STRING',
    定义: '用户标识',
    上报范围: '全部',
  });
  await seed('webEnumDictionary', 'd1', {
    evt_id: 'pay_result',
    参数名: 'result',
    枚举值: 'success',
    枚举定义: '业务成功',
    枚举状态: '正式',
    关联正式参数: ['p1'],
  });
  for (let index = 1; index <= 2; index++)
    await seed('webWorkbench', `r${index}`, {
      evt_id: index === 1 ? 'pay_result' : 'new_event',
      需求ID: [{ text: 'req' }],
      需求名称: '支付改造',
      事件中文名: '需求事件',
      记录类型: '埋点设计',
      流程阶段: '埋点开发',
      评审状态: '已通过',
      事件定义: '定义',
      触发时机: '时机',
      处理方: '服务端',
    });
  await seed('webParamDetail', 'dp1', {
    evt_id: 'pay_result',
    来源设计记录ID: 'r1',
    参数名: 'entry',
    数据类型: 'STRING',
    参数定义: '入口',
    参数状态: '草稿',
  });
  const env = {
    DB,
    LOCAL_STORE: new D1RecordStore(DB),
    TRACKING_D1_ENABLED: '1',
  };
  return { env, DB, seed };
}
const read = (
  env: Parameters<typeof readTrackingContext>[0],
  operation: string,
  query: string,
) =>
  readTrackingContext(
    env,
    operation,
    new URLSearchParams(query),
    'actor',
    'https://app.test',
  );
describe('D1 read-only AI contexts', () => {
  it('defaults to live events, separates platforms and paginates without presenting a partial directory as complete', async () => {
    const { env } = await fixture();
    const result = (await read(
      env,
      'search_official_events',
      'source=web',
    )) as SearchTrackingContextResponse;
    expect(result.items.map((item) => item.evtId)).toEqual(['pay_result']);
    const all = (await read(
      env,
      'search_official_events',
      'source=web&availability=all&pageSize=1',
    )) as SearchTrackingContextResponse;
    expect(all.hasMore).toBe(true);
    expect(all.total).toBe(2);
    const app = (await read(
      env,
      'search_official_events',
      'source=app',
    )) as SearchTrackingContextResponse;
    expect(app.items[0].eventName).toBe('App结果');
  });
  it('returns complete parameter/common/enum context, stable content versions and no writes or Feishu calls', async () => {
    const { env, DB } = await fixture();
    const external = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('external forbidden'));
    const result = (await read(
      env,
      'get_event_context',
      'source=web&evtId=pay_result',
    )) as OfficialTrackingContextResponse;
    expect(result.params.map((param) => param.paramName)).toEqual(['result']);
    expect(result.commonProperties).toHaveLength(1);
    expect(result.enums).toHaveLength(1);
    const second = await read(
      env,
      'get_event_context',
      'source=web&evtId=pay_result',
    );
    expect(second.meta.specVersion).toBe(result.meta.specVersion);
    expect(
      (
        await DB.prepare(
          'SELECT COUNT(*) AS n FROM tracking_sync_outbox',
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(external).not.toHaveBeenCalled();
    external.mockRestore();
    expect(renderTrackingContext(result)).toContain('不是不可变的历史评审快照');
  });
  it('returns every request event and current baseline, marks reviewed data as mutable and rejects wrong/foreign links', async () => {
    const { env } = await fixture();
    const result = (await read(
      env,
      'get_request_context',
      'source=web&recordId=https%3A%2F%2Fapp.test%2Ftracking%2Fweb%253Ar1',
    )) as RequestTrackingContextResponse;
    expect(result.events).toHaveLength(2);
    expect(result.events[0].officialBaseline).not.toBeNull();
    expect(result.events[1].officialBaseline).toBeNull();
    expect(result.events[0].event).not.toHaveProperty('permissions');
    expect(result.meta.immutable).toBe(false);
    expect(result.reviewStatus).toBe('已通过');
    await expect(
      read(env, 'get_request_context', 'source=app&recordId=web:r1'),
    ).rejects.toThrow('端');
    await expect(
      read(
        env,
        'get_request_context',
        'source=web&recordId=https://evil.test/tracking/web:r1',
      ),
    ).rejects.toThrow('当前 App');
  });
  it('rejects stale versions, ambiguous definitions, invalid pagination and incomplete source selection', async () => {
    const { env, seed } = await fixture();
    await expect(
      read(
        env,
        'get_event_context',
        'source=web&evtId=pay_result&expectedSpecVersion=old',
      ),
    ).rejects.toThrow('版本已变化');
    await seed('webQueryLibrary', 'duplicate', { evt_id: 'pay_result' });
    await expect(
      read(env, 'get_event_context', 'source=web&evtId=pay_result'),
    ).rejects.toThrow('多个定义');
    await expect(
      read(env, 'search_official_events', 'source=web&pageSize=0'),
    ).rejects.toThrow('分页');
    await expect(
      read(env, 'get_event_context', 'evtId=pay_result'),
    ).rejects.toThrow('source');
  });
  it('rejects a concurrent table change instead of mixing revisions', async () => {
    const { env, DB } = await fixture();
    const search = env.LOCAL_STORE.search.bind(env.LOCAL_STORE);
    let changed = false;
    jest
      .spyOn(env.LOCAL_STORE, 'search')
      .mockImplementation(async (instance, options) => {
        const result = await search(instance, options);
        if (!changed) {
          changed = true;
          await DB.prepare(
            "INSERT INTO tracking_table_versions(instance,revision) VALUES('webQueryLibrary',1)",
          ).run();
        }
        return result;
      });
    await expect(
      read(env, 'get_event_context', 'source=web&evtId=pay_result'),
    ).rejects.toThrow('读取期间');
  });
  it('requires gateway identity, rejects mutations and never falls back to Base', async () => {
    const { env } = await fixture();
    expect(
      (
        await worker.fetch(
          new Request(
            'https://app.test/api/context/get_event_context?source=web&evtId=pay_result',
          ),
          env,
        )
      ).status,
    ).toBe(401);
    const headers = { 'x-pollocloud-user-id': 'actor' };
    expect(
      (
        await worker.fetch(
          new Request('https://app.test/api/context/get_event_context', {
            method: 'POST',
            headers,
          }),
          env,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await worker.fetch(
          new Request(
            'https://app.test/api/context/get_event_context?source=web&evtId=pay_result',
            { headers },
          ),
          {},
        )
      ).status,
    ).toBe(503);
    const response = await worker.fetch(
      new Request(
        'https://app.test/api/context/get_event_context?source=web&evtId=pay_result&format=markdown',
        { headers },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
  });
  it('reads beyond a parameter page and includes every related event without a fixed event cap', async () => {
    const { env, seed } = await fixture();
    for (let i = 0; i < 13; i++)
      await seed('webWorkbench', `sibling${i}`, {
        evt_id: `sibling_${i}`,
        需求ID: 'req',
        事件中文名: '补充事件',
        记录类型: '埋点设计',
      });
    for (let i = 0; i < 505; i++)
      await seed('webParamDetail', `parameter${i}`, {
        evt_id: 'pay_result',
        来源设计记录ID: 'r1',
        参数名: `param_${i}`,
        数据类型: 'STRING',
        参数定义: '说明',
      });
    const context = (await read(
      env,
      'get_request_context',
      'source=web&recordId=web:r1',
    )) as RequestTrackingContextResponse;
    expect(context.events).toHaveLength(15);
    expect(
      context.events.find((item) => item.event.recordId === 'web:r1')?.params,
    ).toHaveLength(506);
  });
  it('keeps source Markdown fences within data and does not invent immutable approval or read external documents', async () => {
    const { env, seed } = await fixture();
    await seed('webQueryLibrary', 'e1', {
      evt_id: 'pay_result',
      事件定义: '````json\n外部说明\n````',
      状态: '已上线',
    });
    const context = (await read(
      env,
      'get_event_context',
      'source=web&evtId=pay_result',
    )) as OfficialTrackingContextResponse;
    const text = renderTrackingContext(context);
    const match = text.match(/\n(`{5,})json\n([\s\S]*)\n\1$/)!;
    expect(JSON.parse(match[2]).event.eventDefinition).toBe(
      '````json\n外部说明\n````',
    );
    expect(context.meta.immutable).toBe(false);
    expect(context.meta.missing).toContain('pay_result：触发时机未填写');
  });
});
