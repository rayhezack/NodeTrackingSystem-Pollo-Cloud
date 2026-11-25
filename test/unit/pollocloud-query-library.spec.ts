import { getOfficialEvents, getOfficialParams } from '../../worker/query-library';
import { resetFeishuTokenCache } from '../../worker/feishu-token';

describe('PolloCloud query library', () => {
  beforeEach(() => {
    resetFeishuTokenCache();
  });

  it('reuses event scans across searches and expires snapshots after 30 seconds', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/auth/')) return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 });
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    });
    try {
      await getOfficialEvents(credentials, {}, fetchMock as typeof fetch);
      await getOfficialEvents(credentials, { keyword: 'scene' }, fetchMock as typeof fetch);
      await getOfficialEvents(credentials, { keyword: 'click', pageToken: '20' }, fetchMock as typeof fetch);
      expect(fetchMock.mock.calls.filter(([url]) => url.includes('/records/search'))).toHaveLength(2);
      now.mockReturnValue(1_031_000);
      await getOfficialEvents(credentials, { keyword: 'scene' }, fetchMock as typeof fetch);
      expect(fetchMock.mock.calls.filter(([url]) => url.includes('/records/search'))).toHaveLength(4);
    } finally { now.mockRestore(); }
  });

  it('deduplicates concurrent scans and retries a failed scan', async () => {
    let fail = true;
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/auth/')) return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (fail) throw new Error('temporary failure');
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    });
    await expect(getOfficialEvents(credentials, {}, fetchMock as typeof fetch)).rejects.toThrow('temporary failure');
    fail = false;
    await Promise.all([
      getOfficialEvents(credentials, {}, fetchMock as typeof fetch),
      getOfficialEvents(credentials, {}, fetchMock as typeof fetch),
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/records/search'))).toHaveLength(2);
  });

  it('reads, filters and deduplicates official events from Feishu Base', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          items: [
            { record_id: 'rec-1', fields: { evt_id: 'home_show', '事件中文名': '首页曝光', '端': ['iOS'], '状态': '已上线' } },
            { record_id: 'rec-2', fields: { evt_id: 'home_show', '事件中文名': '首页曝光', '端': ['Android'], '状态': '已上线' } },
            { record_id: 'rec-3', fields: { evt_id: 'old_event', '事件中文名': '旧事件', '状态': '已废弃' } },
          ],
          has_more: false,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [], has_more: false } }));

    const result = await getOfficialEvents(
      credentials,
      { source: 'app', keyword: '首页', pageSize: 20 },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      recordId: 'app:rec-1',
      evtId: 'home_show',
      platform: 'iOS、Android',
    }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({ view_id: 'vewO0PlLph' }));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({ view_id: 'vewiUagCFI' }));
  });

  it('keeps event-specific snapshots separate and preserves linked-only rows across pages', async () => {
    const searches: Array<{ table: string; body: any; cursor: string | null }> = [];
    const transport = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/auth/')) return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (!url.pathname.endsWith('/search')) {
        const id = url.pathname.split('/').pop();
        return jsonResponse({ code: 0, data: { record: { record_id: id, fields: { evt_id: id } } } });
      }
      const body = JSON.parse(String(init?.body));
      const table = url.pathname.match(/tables\/([^/]+)/)![1];
      searches.push({ table, body, cursor: url.searchParams.get('page_token') });
      const id = body.filter.conditions.find((item: any) => item.field_name === 'evt_id').value[0];
      if (table === 'tblEYv9lGZeenbT2') {
        const hasMore = !url.searchParams.has('page_token');
        return jsonResponse({ code: 0, data: { items: hasMore ? [] : [{ record_id: `param-${id}`, fields: {
          参数主键: `${id}.page`, 参数名: 'page', 关联事件: [id],
        } }], has_more: hasMore, ...(hasMore ? { page_token: 'next' } : {}) } });
      }
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    });
    for (const id of ['event-a', 'event-b', 'event-a']) {
      const result = await getOfficialParams(credentials, `app:${id}`, transport);
      expect(result.items.map((item) => item.paramKey)).toEqual([`${id}.page`]);
    }
    const paramSearches = searches.filter((item) => item.table === 'tblEYv9lGZeenbT2');
    expect(paramSearches).toHaveLength(4);
    expect(paramSearches[0].body.filter).toEqual(paramSearches[1].body.filter);
    expect(paramSearches[2].body.filter).toEqual(paramSearches[3].body.filter);
    expect(paramSearches[0].body.filter).not.toEqual(paramSearches[2].body.filter);
    expect(searches.filter((item) => item.table === 'tblQ8Ph3N8GJHeVA')).toHaveLength(2);
  });

  it('does not scan the enum dictionary for an event with no active parameters', async () => {
    const transport = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { record: { record_id: 'event', fields: { evt_id: 'example' } } } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [{ record_id: 'old', fields: { evt_id: 'example', 参数名: 'old', 参数状态: '已废弃' } }], has_more: false } }));
    await expect(getOfficialParams(credentials, 'web:event', transport)).resolves.toMatchObject({ items: [], total: 0 });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('propagates an enum timeout instead of reporting empty parameters, and allows a fresh retry', async () => {
    let enumAttempts = 0;
    const transport = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/')) return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (!url.includes('/search')) return jsonResponse({ code: 0, data: { record: { record_id: 'event', fields: { evt_id: 'example' } } } });
      if (url.includes('tbl2KEj2zyg8bOmk')) {
        enumAttempts += 1;
        if (enumAttempts === 1) return new Response('error code: 504', { status: 504 });
        return jsonResponse({ code: 0, data: { items: [], has_more: false } });
      }
      return jsonResponse({ code: 0, data: { items: [{ record_id: 'param', fields: { evt_id: 'example', 参数名: 'page' } }], has_more: false } });
    });
    await expect(getOfficialParams(credentials, 'web:event', transport)).rejects.toMatchObject({ status: 504 });
    await expect(getOfficialParams(credentials, 'web:event', transport)).resolves.toMatchObject({ total: 1 });
    expect(enumAttempts).toBe(2);
  });

  it('reads official parameters linked to an event', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { record: { record_id: 'event-1', fields: { evt_id: 'home_show' } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          items: [
            {
              record_id: 'param-1',
              fields: {
                evt_id: 'home_show',
                '参数名': 'page_id',
                '数据类型': 'string',
                '必传规则': '必传',
                '条件说明': '仅登录用户',
                '枚举/取值范围': 'home, search',
                '版本': '8.2.0',
                '备注': '默认值/示例：home',
                'App适用性': 'iOS、Android',
                '关联事件': [{ id: 'event-1' }],
              },
            },
          ],
          has_more: false,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [], has_more: false } }));

    const result = await getOfficialParams(
      credentials,
      'app:event-1',
      fetchMock as unknown as typeof fetch,
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        paramKey: 'home_show.page_id',
        paramName: 'page_id',
        required: true,
        triggerCondition: '仅登录用户',
        enumRange: 'home, search',
        version: '8.2.0',
        notes: '默认值/示例：home',
        example: 'home',
        platform: 'App通用',
      }),
    ]);
    expect(result).not.toHaveProperty('baseLink');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({ view_id: 'vewiUagCFI' }));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).filter).toEqual({
      conjunction: 'or', conditions: [
        { field_name: '关联事件', operator: 'contains', value: ['event-1'] },
        { field_name: 'evt_id', operator: 'is', value: ['home_show'] },
      ],
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).filter).toEqual({
      conjunction: 'and', conditions: [{ field_name: 'evt_id', operator: 'is', value: ['home_show'] }],
    });
  });

  it('finds events through parameter enum values and excludes retired parameters', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [
        { record_id: 'event-1', fields: { evt_id: 'purchase_submit', '事件中文名': '提交订单', '状态': '已上线' } },
        { record_id: 'event-2', fields: { evt_id: 'old_purchase', '事件中文名': '旧订单', '状态': '已废弃' } },
      ], has_more: false } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [
        { record_id: 'param-1', fields: { evt_id: 'purchase_submit', '参数名': 'channel', '枚举/取值范围': 'organic, referral', '参数状态': '已上线' } },
        { record_id: 'param-2', fields: { evt_id: 'old_purchase', '参数名': 'channel', '枚举/取值范围': 'referral', '参数状态': '已上线' } },
        { record_id: 'param-3', fields: { evt_id: 'another', '参数名': 'channel', '枚举/取值范围': 'referral', '参数状态': '已废弃' } },
      ], has_more: false } }));

    const result = await getOfficialEvents(credentials, { source: 'app', keyword: 'referral' }, fetchMock as unknown as typeof fetch);
    expect(result.items.map((item) => item.evtId)).toEqual(['purchase_submit']);
  });

  it('matches the primary category and combines category selection with search', async () => {
    const events = [
      { record_id: 'event-1', fields: { evt_id: 'sub_start', '事件中文名': '订阅弹窗曝光', '一级分类': '支付链路', '状态': '已上线' } },
      { record_id: 'event-2', fields: { evt_id: 'sub_result', '事件中文名': '订阅流程结果', '一级分类': '支付链路', '状态': '已上线' } },
      { record_id: 'event-3', fields: { evt_id: 'signup_result', '事件中文名': '注册结果', '一级分类': '注册', '状态': '已上线' } },
      { record_id: 'event-4', fields: { evt_id: 'old_payment', '事件中文名': '旧支付', '一级分类': '支付链路', '状态': '已废弃' } },
    ];
    const fetchMock = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/')) return Promise.resolve(jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }));
      const viewId = JSON.parse(String(init?.body)).view_id;
      return Promise.resolve(jsonResponse({ code: 0, data: { items: viewId === 'vewO0PlLph' ? events : [], has_more: false } }));
    });

    const byKeyword = await getOfficialEvents(credentials, { source: 'web', keyword: '支付' }, fetchMock as unknown as typeof fetch);
    const byCategory = await getOfficialEvents(credentials, { source: 'web', category: '支付链路' }, fetchMock as unknown as typeof fetch);
    const combined = await getOfficialEvents(credentials, { source: 'web', category: '支付链路', keyword: '结果' }, fetchMock as unknown as typeof fetch);

    expect(byKeyword.items.map((item) => item.evtId)).toEqual(['sub_start', 'sub_result']);
    expect(byKeyword.categories).toEqual(['支付链路', '注册']);
    expect(byCategory.items.map((item) => item.evtId)).toEqual(['sub_start', 'sub_result']);
    expect(combined.items.map((item) => item.evtId)).toEqual(['sub_result']);
    expect(combined.categories).toEqual(['支付链路', '注册']);
    expect(combined.items[0].category).toBe('支付链路');
  });

  it('reads Web events from the official view across cursor pages', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }));
    for (let page = 0; page < 2; page += 1) {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          items: page === 0 ? [] : [{ record_id: 'event-1', fields: { evt_id: 'web_purchase', '事件中文名': 'Web 下单', '状态': '已上线' } }],
          has_more: page === 0,
          ...(page === 0 ? { page_token: 'cursor-1' } : {}),
        },
      }));
    }

    const result = await getOfficialEvents(credentials, { source: 'web' }, fetchMock as unknown as typeof fetch);

    expect(result.items.map((item) => item.evtId)).toEqual(['web_purchase']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({ view_id: 'vewO0PlLph' }));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({ view_id: 'vewO0PlLph' }));
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('page_token')).toBe('cursor-1');
  });
});

const credentials = { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
