import type {
  OfficialEvent,
  OfficialEventContext,
  OfficialTrackingContextResponse,
  RequestTrackingContextResponse,
  SearchTrackingContextResponse,
  TrackingContextMeta,
  TrackingSource,
} from '../shared/api.interface';
import { recordCellText } from './d1-record-store';
import type { FeishuCredentials } from './feishu-token';
import type { BitableInstanceKey, BitableRecord } from './feishu-bitable';
import { getOfficialParams, toOfficialEvent } from './query-library';
import { getTrackingDetail, getTrackingParams } from './tracking-read';
import { assertParameterContracts } from '../shared/official-first-workflow';
import type { D1Database } from './ai-tracking';

export class ContextError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
type ContextEnv = FeishuCredentials & { DB?: D1Database };
type ContextResult =
  | SearchTrackingContextResponse
  | OfficialTrackingContextResponse
  | RequestTrackingContextResponse;

/** Every page and dependency is read from D1, with a before/after revision check. */
export async function readTrackingContext(
  env: ContextEnv,
  operation: string,
  params: URLSearchParams,
  actorId: string,
  appOrigin: string,
): Promise<ContextResult> {
  if (!env.DB || !env.LOCAL_STORE)
    throw new ContextError('上下文服务需要已启用的 D1 主存储', 503);
  const before = await revisions(env.DB);
  const source = params.get('source');
  if (source !== 'web' && source !== 'app')
    throw new ContextError('source 必须为 web 或 app');
  const warnings = [
    '当前已保存数据；未提供不可变历史评审快照。',
    '定义库不包含行为明细、统计结果或未经维护的数仓映射。',
  ];
  const missing: string[] = [];
  let scope: TrackingContextMeta['scope'];
  let sourcePath: string;
  let content:
    | Omit<SearchTrackingContextResponse, 'meta'>
    | Omit<OfficialTrackingContextResponse, 'meta'>
    | Omit<RequestTrackingContextResponse, 'meta'>;
  if (operation === 'search_official_events') {
    scope = 'official-search';
    sourcePath = '/query-library';
    const availability = params.get('availability') || 'live';
    if (!['live', 'all'].includes(availability))
      throw new ContextError('availability 必须为 live 或 all');
    const size = integer(params.get('pageSize'), 20, 1, 50);
    const offset = integer(
      params.get('pageToken'),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const keyword = (params.get('keyword') || '').trim().toLocaleLowerCase();
    const category = params.get('category') || '';
    const events = (await rows(env, key(source, 'queryLibrary'))).map((row) =>
      toOfficialEvent(row, source),
    );
    const active = events.filter((event) => event.evtId && !excluded(event));
    const matchingParams = keyword
      ? await rows(env, key(source, 'officialParamDetail'))
      : [];
    const matchingIds = new Set(
      matchingParams
        .filter((row) =>
          Object.values(row.record)
            .map(recordCellText)
            .join(' ')
            .toLocaleLowerCase()
            .includes(keyword),
        )
        .map((row) => recordCellText(row.record.evt_id)),
    );
    const matches = active.filter(
      (event) =>
        (availability === 'all' || live(event)) &&
        (!category || event.category === category) &&
        (!keyword ||
          [
            event.evtId,
            event.eventName,
            event.category,
            event.eventDefinition,
            event.triggerTiming,
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(keyword) ||
          matchingIds.has(event.evtId)),
    );
    if (offset + size < matches.length)
      warnings.push('候选目录还有后续页，请按 pageToken 继续检索。');
    if (availability === 'all')
      warnings.push(
        'all 目录包含待开发等非上线状态；不能将注册在库等同于已上报。废弃及待治理事件不在搜索目录中。',
      );
    content = {
      items: matches.slice(offset, offset + size),
      total: matches.length,
      categories: [
        ...new Set(
          active
            .map((event) => event.category)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort(),
      hasMore: offset + size < matches.length,
      pageToken:
        offset + size < matches.length ? String(offset + size) : undefined,
    };
  } else if (operation === 'get_event_context') {
    scope = 'official-event';
    sourcePath = '/query-library';
    const event = await findEvent(
      env,
      source,
      params.get('evtId'),
      params.get('recordId'),
    );
    if (!event)
      throw new ContextError('正式事件不存在，请先搜索并核对端及 ID', 404);
    const context = await eventContext(env, event);
    checkEvent(context, missing, warnings);
    content = {
      ...context,
      ...(await referenceContext(env, source, new Set([event.evtId]))),
    };
  } else if (operation === 'get_request_context') {
    scope = 'request';
    const recordId = requestRecordId(
      params.get('recordId') || '',
      source,
      appOrigin,
    );
    sourcePath = `/tracking/${encodeURIComponent(recordId)}?stage=dev`;
    const stored = await env.LOCAL_STORE.get(
      source === 'web' ? 'webWorkbench' : 'workbench',
      recordId.slice(source.length + 1),
    );
    if (
      !stored ||
      ['模板', '权限配置'].includes(recordCellText(stored.record['记录类型']))
    )
      throw new ContextError('埋点需求不存在', 404);
    const root = (await getTrackingDetail(env, recordId, actorId)).data;
    if (root.source !== source)
      throw new ContextError('需求链接与 source 不一致');
    const related = root.relatedEvents.length
      ? root.relatedEvents
      : [{ recordId: root.recordId, detail: root }];
    if (!related.some((event) => event.recordId === root.recordId))
      throw new ContextError('需求事件列表不完整', 409);
    const events: RequestTrackingContextResponse['events'] = [];
    for (const relatedEvent of related) {
      const detail =
        relatedEvent.recordId === root.recordId
          ? root
          : relatedEvent.detail ||
            (await getTrackingDetail(env, relatedEvent.recordId, actorId)).data;
      const {
        relatedEvents: _related,
        permissions: _permissions,
        ...event
      } = { ...detail, relatedEvents: [] };
      const parameters = await getTrackingParams(
        env,
        event.recordId,
        fetch,
        true,
      );
      if (parameters.items.length !== parameters.total)
        throw new ContextError('参数未完整读取', 409);
      const official = event.evtId
        ? await findEvent(env, source, event.evtId, null, false)
        : null;
      const officialBaseline = official
        ? await eventContext(env, official)
        : null;
      events.push({ event, params: parameters.items, officialBaseline });
      for (const field of ['事件定义', '触发时机', '处理方'])
        if (!recordCellText(event.designFields[field]))
          missing.push(`${event.evtId || event.recordId}：${field}未填写`);
      if (!event.evtId) missing.push(`${event.recordId}：evt_id 未填写`);
      for (const param of parameters.items)
        if (!param.definition)
          missing.push(`${param.paramKey}：参数定义未填写`);
    }
    warnings.push(
      'officialBaseline 是读取时的正式定义，尚未绑定历史基线；本次未自动计算历史差异。',
      'PRD 和 UI 素材以原链接/附件标识提供，未抓取文档全文或图片；临时预览地址可能过期。',
      '参数包含删除/废弃标记；这些参数用于理解变更，不纳入新上报载荷。',
    );
    const unreviewed = events.filter(
      (item) => item.event.reviewStatus !== '已通过',
    );
    if (unreviewed.length)
      warnings.push(
        `未全部通过评审：${unreviewed.map((item) => item.event.evtId || item.event.recordId).join('、')}`,
      );
    if (root.reviewStatus !== '已通过')
      warnings.push(
        `当前评审状态为${root.reviewStatus}，用于讨论，不能视为开发定稿。`,
      );
    else
      warnings.push(
        '当前状态为评审已通过，但数据仍可更新；不代表不可变的评审版本。',
      );
    content = {
      requestId: root.requestId || '',
      requestName: root.requestName || root.eventName,
      reviewStatus: unreviewed.length ? '未全部通过' : root.reviewStatus,
      events,
      ...(await referenceContext(
        env,
        source,
        new Set(events.map((item) => item.event.evtId)),
      )),
    };
  } else throw new ContextError('未知上下文操作', 404);
  if ('commonProperties' in content && !content.commonProperties.length)
    missing.push('公共属性库为空，使用前确认是否完整');
  if (before !== (await revisions(env.DB)))
    throw new ContextError('读取期间埋点数据已变化，请重新获取完整上下文', 409);
  const specVersion = `sha256:${await digest({ source, scope, content })}`;
  if (
    params.get('expectedSpecVersion') &&
    params.get('expectedSpecVersion') !== specVersion
  )
    throw new ContextError('数据版本已变化，请重新获取并评审上下文', 409);
  return {
    ...content,
    meta: {
      schemaVersion: 'tracking-context/v1',
      dataSource: 'd1',
      scope,
      snapshotKind: 'current-saved',
      immutable: false,
      source,
      sourcePath,
      specVersion,
      generatedAt: new Date().toISOString(),
      fullRead: true,
      missing: [...new Set(missing)],
      warnings,
    },
  };
}

async function rows(
  env: ContextEnv,
  instance: BitableInstanceKey,
): Promise<BitableRecord[]> {
  const records: BitableRecord[] = [];
  let token: string | undefined;
  do {
    const page = await env.LOCAL_STORE!.search(instance, {
      pageSize: 500,
      pageToken: token,
    });
    records.push(...page.records);
    if (!page.hasMore) break;
    if (!page.pageToken || page.pageToken === token)
      throw new ContextError('分页不完整，未返回部分上下文', 409);
    token = page.pageToken;
  } while (true);
  return records;
}
function key(
  source: TrackingSource,
  instance:
    | 'queryLibrary'
    | 'officialParamDetail'
    | 'commonProperties'
    | 'enumDictionary',
): BitableInstanceKey {
  return source === 'web'
    ? (`web${instance[0].toUpperCase()}${instance.slice(1)}` as BitableInstanceKey)
    : instance;
}
async function findEvent(
  env: ContextEnv,
  source: TrackingSource,
  evtId: string | null,
  recordId: string | null,
  required = true,
): Promise<OfficialEvent | null> {
  if (!evtId && !recordId && required)
    throw new ContextError('提供 evtId 或带端前缀的 recordId');
  if (recordId && !recordId.startsWith(`${source}:`))
    throw new ContextError('事件 recordId 必须包含正确的端前缀');
  const candidates = (await rows(env, key(source, 'queryLibrary')))
    .map((row) => toOfficialEvent(row, source))
    .filter(
      (event) =>
        (!evtId || event.evtId === evtId) &&
        (!recordId || event.recordId === recordId),
    );
  if (candidates.length > 1)
    throw new ContextError(
      '同端事件 ID 存在多个定义，请指定 recordId 并治理重复定义',
      409,
    );
  return candidates[0] || null;
}
async function eventContext(
  env: ContextEnv,
  event: OfficialEvent,
): Promise<OfficialEventContext> {
  const params = await getOfficialParams(env, event.recordId);
  if (params.items.length !== params.total)
    throw new ContextError('正式参数未完整读取', 409);
  assertParameterContracts(event.evtId, params.items);
  return { event, params: params.items };
}
async function referenceContext(
  env: ContextEnv,
  source: TrackingSource,
  eventIds: Set<string>,
) {
  const commonProperties = (await rows(env, key(source, 'commonProperties')))
    .map((row) => ({
      name: recordCellText(row.record['属性名']),
      type: recordCellText(row.record['格式']),
      definition: recordCellText(row.record['定义']),
      scope: recordCellText(row.record['上报范围']),
    }))
    .filter((prop) => prop.name);
  const enums = (await rows(env, key(source, 'enumDictionary')))
    .filter(
      (row) =>
        eventIds.has(recordCellText(row.record.evt_id)) ||
        !recordCellText(row.record.evt_id),
    )
    .map((row) => ({
      evtId: recordCellText(row.record.evt_id),
      paramName: recordCellText(row.record['参数名']),
      value: recordCellText(row.record['枚举值']),
      definition: recordCellText(row.record['枚举定义']),
      status: recordCellText(row.record['枚举状态']),
    }));
  return { commonProperties, enums };
}
function checkEvent(
  context: OfficialEventContext,
  missing: string[],
  warnings: string[],
) {
  const { event, params } = context;
  if (!event.eventDefinition || /未提供|待.*补充/.test(event.eventDefinition))
    missing.push(`${event.evtId}：正式事件定义不完整`);
  if (!event.triggerTiming) missing.push(`${event.evtId}：触发时机未填写`);
  if (!params.length)
    warnings.push(`${event.evtId} 没有有效正式参数，需确认是否无需事件参数`);
  for (const param of params)
    if (!param.definition)
      missing.push(`${event.evtId}.${param.paramName}：定义未填写`);
  if (excluded(event))
    warnings.push('该事件已废弃或待治理，禁止作为可用契约。');
  else if (!live(event))
    warnings.push(
      `该事件状态为${event.status}，未确认上线，不能据此进行线上统计分析。`,
    );
  if (event.lifecycleStatus !== '稳定归档')
    warnings.push('正式生命周期尚未稳定归档，定义需确认。');
}
function excluded(event: OfficialEvent) {
  return /废弃|待治理/.test(`${event.status} ${event.lifecycleStatus}`);
}
function live(event: OfficialEvent) {
  return (
    ['已上线', '已发布', '正式'].includes(event.status.trim()) &&
    !excluded(event)
  );
}
function integer(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const number = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new ContextError('分页参数无效');
  return number;
}
function requestRecordId(
  input: string,
  source: TrackingSource,
  origin: string,
): string {
  let id = input;
  if (
    input.startsWith('https://') ||
    input.startsWith('http://') ||
    input.startsWith('/')
  ) {
    const url = new URL(input, origin);
    if (url.origin !== origin)
      throw new ContextError('请提供当前 App 的需求链接');
    const match = url.pathname.match(/^\/tracking\/([^/]+)$/);
    if (!match) throw new ContextError('不是有效的需求链接');
    id = decodeURIComponent(match[1]);
  }
  if (!id.startsWith(`${source}:`) || !/^(web|app):[A-Za-z0-9_-]+$/.test(id))
    throw new ContextError('需求 recordId 或链接的端不正确');
  return id;
}
async function revisions(db: D1Database): Promise<string> {
  const result = await db
    .prepare(
      'SELECT instance,revision FROM tracking_table_versions ORDER BY instance',
    )
    .all();
  return JSON.stringify(result.results || []);
}
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
