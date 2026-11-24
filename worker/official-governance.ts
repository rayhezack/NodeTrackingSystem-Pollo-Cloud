import { OFFICIAL_GOVERNANCE_LIFECYCLES, OFFICIAL_GOVERNANCE_STATUSES } from '../shared/api.interface';
import type {
  OfficialGovernanceChange, OfficialGovernanceItem, OfficialGovernanceRequest, OfficialGovernanceResponse, TrackingSource,
} from '../shared/api.interface';
import { recordCellText } from './d1-record-store';
import { searchBitableRecordPage, updateBitableRecords, type BitableInstanceKey, type BitableRecord } from './feishu-bitable';
import type { FeishuCredentials } from './feishu-token';
import { TrackingWriteError } from './tracking-write';

const MAX_ITEMS = 200;
const MAX_NOTE_LENGTH = 300;

/**
 * Admin-only correction of an official event's 状态 / 生命周期状态, e.g. after checking real report volume.
 * Only these two fields are written. It runs on the D1 primary store so the change is synced to Base
 * through the outbox; editing Base directly would never reach D1.
 * The reason note is returned for the preview and the operator's own records but is not stored on the event:
 * the official table has no free-text note field, and 最近评审记录 is a URL field that Base rejects text for.
 * Deprecation is refused here: it must go through a 废弃 requirement, which moves the event to the deprecated library.
 */
export async function applyOfficialGovernance(
  env: FeishuCredentials,
  body: unknown,
  operator: { name: string },
  now: Date = new Date(),
): Promise<OfficialGovernanceResponse> {
  if (!env.LOCAL_STORE) throw new TrackingWriteError('正式库治理只在 D1 主存储模式下可用；不要直接修改 Base', 409);
  const request = parseGovernanceRequest(body);
  const instance: BitableInstanceKey = request.source === 'web' ? 'webQueryLibrary' : 'queryLibrary';
  const events = await listAllRecords(env, instance);
  const date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const errors: string[] = [];
  const changes: OfficialGovernanceChange[] = [];
  const unchanged: string[] = [];

  for (const item of request.items) {
    const matches = events.filter((row) => recordCellText(row.record.evt_id) === item.evtId);
    if (!matches.length) { errors.push(`正式库中找不到事件：${item.evtId}`); continue; }
    if (matches.length > 1) { errors.push(`正式库存在重复事件，需先治理：${item.evtId}`); continue; }
    const row = matches[0];
    const before = { status: recordCellText(row.record['状态']), lifecycleStatus: recordCellText(row.record['生命周期状态']) };
    if (before.status === '已废弃' || before.lifecycleStatus === '已废弃') {
      errors.push(`${item.evtId} 已废弃，请通过废弃需求单处理`);
      continue;
    }
    const after = { status: item.status ?? before.status, lifecycleStatus: item.lifecycleStatus ?? before.lifecycleStatus };
    if (after.status === before.status && after.lifecycleStatus === before.lifecycleStatus) {
      unchanged.push(item.evtId);
      continue;
    }
    const reviewNote = `${date} ${operator.name || '管理员'} 正式库治理：${describeChange(before, after)}。${item.note}`;
    changes.push({ evtId: item.evtId, recordId: row.id, before, after, reviewNote });
  }
  if (errors.length) throw new TrackingWriteError(errors.join('\n'), 400);

  if (!request.dryRun && changes.length) {
    await updateBitableRecords(env, instance, changes.map((change) => ({
      id: change.recordId,
      record: {
        ...(change.after.status !== change.before.status ? { 状态: change.after.status } : {}),
        ...(change.after.lifecycleStatus !== change.before.lifecycleStatus ? { 生命周期状态: change.after.lifecycleStatus } : {}),
      },
    })));
  }
  return { source: request.source, dryRun: request.dryRun, changes, unchanged };
}

export function parseGovernanceRequest(body: unknown): OfficialGovernanceRequest {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const errors: string[] = [];
  const source = value.source;
  if (source !== 'web' && source !== 'app') errors.push('source 必须是 web 或 app');
  // Anything other than an explicit false is treated as a preview, so a malformed request can never write.
  const dryRun = value.dryRun !== false;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  if (!rawItems.length) errors.push('items 不能为空');
  if (rawItems.length > MAX_ITEMS) errors.push(`单次最多 ${MAX_ITEMS} 条`);
  const seen = new Set<string>();
  const items: OfficialGovernanceItem[] = [];
  rawItems.forEach((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const label = `第 ${index + 1} 条`;
    const evtId = typeof item.evtId === 'string' ? item.evtId.trim() : '';
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    const status = item.status;
    const lifecycleStatus = item.lifecycleStatus;
    if (!evtId) errors.push(`${label}缺少 evtId`);
    else if (seen.has(evtId)) errors.push(`${label}重复：${evtId}`);
    seen.add(evtId);
    if (status === undefined && lifecycleStatus === undefined) errors.push(`${label}（${evtId}）至少要改状态或生命周期状态之一`);
    if (status !== undefined && !(OFFICIAL_GOVERNANCE_STATUSES as readonly unknown[]).includes(status)) {
      errors.push(`${label}（${evtId}）状态只能是：${OFFICIAL_GOVERNANCE_STATUSES.join('、')}；废弃请走废弃需求单`);
    }
    if (lifecycleStatus !== undefined && !(OFFICIAL_GOVERNANCE_LIFECYCLES as readonly unknown[]).includes(lifecycleStatus)) {
      errors.push(`${label}（${evtId}）生命周期状态只能是：${OFFICIAL_GOVERNANCE_LIFECYCLES.join('、')}`);
    }
    if (!note) errors.push(`${label}（${evtId}）缺少原因说明 note`);
    if (note.length > MAX_NOTE_LENGTH) errors.push(`${label}（${evtId}）原因说明超过 ${MAX_NOTE_LENGTH} 字`);
    items.push({
      evtId, note,
      ...(status !== undefined ? { status: status as OfficialGovernanceItem['status'] } : {}),
      ...(lifecycleStatus !== undefined ? { lifecycleStatus: lifecycleStatus as OfficialGovernanceItem['lifecycleStatus'] } : {}),
    });
  });
  if (errors.length) throw new TrackingWriteError(errors.join('\n'), 400);
  return { source: source as TrackingSource, dryRun, items };
}

async function listAllRecords(env: FeishuCredentials, instance: BitableInstanceKey): Promise<BitableRecord[]> {
  const records: BitableRecord[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await searchBitableRecordPage(env, instance, { pageSize: 500, pageToken });
    records.push(...result.records);
    if (!result.hasMore) return records;
    pageToken = result.pageToken;
  }
  throw new TrackingWriteError('正式事件超过 10000 条，治理前请联系开发', 500);
}

function describeChange(before: { status: string; lifecycleStatus: string }, after: { status: string; lifecycleStatus: string }): string {
  const show = (value: string) => value || '空';
  return [
    before.status !== after.status ? `状态 ${show(before.status)}→${after.status}` : '',
    before.lifecycleStatus !== after.lifecycleStatus ? `生命周期 ${show(before.lifecycleStatus)}→${after.lifecycleStatus}` : '',
  ].filter(Boolean).join('，');
}
