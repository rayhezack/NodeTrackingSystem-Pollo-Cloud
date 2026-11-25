import { OFFICIAL_PARAM_GOVERNANCE_REQUIRED_RULES, OFFICIAL_PARAM_GOVERNANCE_TYPES } from '../shared/api.interface';
import type {
  OfficialParamGovernanceChange, OfficialParamGovernanceItem, OfficialParamGovernanceRequest,
  OfficialParamGovernanceResponse, TrackingSource,
} from '../shared/api.interface';
import { recordCellText } from './d1-record-store';
import { updateBitableRecords, type BitableInstanceKey } from './feishu-bitable';
import type { FeishuCredentials } from './feishu-token';
import { listAllRecords } from './official-governance';
import { TrackingWriteError } from './tracking-write';

const MAX_ITEMS = 500;
const MAX_TEXT_LENGTH = 300;

/**
 * Admin-only correction of an official parameter's 数据类型 / 必传规则 / 条件说明, e.g. from real log evidence.
 * 数据类型 and 必传规则 are single-select fields and 条件说明 is plain text in both Base parameter tables; no other
 * field is written. Runs on the D1 primary store; Base is updated through the outbox.
 */
export async function applyOfficialParamGovernance(
  env: FeishuCredentials,
  body: unknown,
  operator: { name: string },
  now: Date = new Date(),
): Promise<OfficialParamGovernanceResponse> {
  if (!env.LOCAL_STORE) throw new TrackingWriteError('正式参数治理只在 D1 主存储模式下可用；不要直接修改 Base', 409);
  const request = parseParamGovernanceRequest(body);
  const instance: BitableInstanceKey = request.source === 'web' ? 'webOfficialParamDetail' : 'officialParamDetail';
  const params = await listAllRecords(env, instance);
  const date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const errors: string[] = [];
  const changes: OfficialParamGovernanceChange[] = [];
  const unchanged: string[] = [];

  for (const item of request.items) {
    const label = `${item.evtId}.${item.paramName}`;
    const matches = params.filter((row) => recordCellText(row.record.evt_id) === item.evtId && recordCellText(row.record['参数名']) === item.paramName);
    if (!matches.length) { errors.push(`正式参数中找不到：${label}`); continue; }
    if (matches.length > 1) { errors.push(`正式参数重复，需先治理：${label}`); continue; }
    const row = matches[0];
    if (recordCellText(row.record['参数状态']) === '已废弃') { errors.push(`${label} 已废弃，不能修改`); continue; }
    const before = {
      dataType: recordCellText(row.record['数据类型']),
      requiredRule: recordCellText(row.record['必传规则']),
      condition: plainText(row.record['条件说明']),
    };
    const after = {
      dataType: item.dataType ?? before.dataType,
      requiredRule: item.requiredRule ?? before.requiredRule,
      condition: item.condition ?? before.condition,
    };
    if (after.requiredRule === '条件必传' && !after.condition) { errors.push(`${label} 改为条件必传时需要填写条件说明 condition`); continue; }
    if (after.dataType === before.dataType && after.requiredRule === before.requiredRule && after.condition === before.condition) {
      unchanged.push(label);
      continue;
    }
    changes.push({ evtId: item.evtId, paramName: item.paramName, recordId: row.id, before, after,
      note: `${date} ${operator.name || '管理员'} 正式参数治理：${describeChange(before, after)}。${item.note}` });
  }
  if (errors.length) throw new TrackingWriteError(errors.join('\n'), 400);

  if (!request.dryRun && changes.length) {
    await updateBitableRecords(env, instance, changes.map((change) => ({
      id: change.recordId,
      record: {
        ...(change.after.dataType !== change.before.dataType ? { 数据类型: change.after.dataType } : {}),
        ...(change.after.requiredRule !== change.before.requiredRule ? { 必传规则: change.after.requiredRule } : {}),
        ...(change.after.condition !== change.before.condition ? { 条件说明: change.after.condition } : {}),
      },
    })));
  }
  return { source: request.source, dryRun: request.dryRun, changes, unchanged };
}

export function parseParamGovernanceRequest(body: unknown): OfficialParamGovernanceRequest {
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
  const items: OfficialParamGovernanceItem[] = [];
  rawItems.forEach((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const evtId = typeof item.evtId === 'string' ? item.evtId.trim() : '';
    const paramName = typeof item.paramName === 'string' ? item.paramName.trim() : '';
    const label = `第 ${index + 1} 条（${evtId}.${paramName}）`;
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    const { dataType, requiredRule } = item;
    const condition = item.condition === undefined ? undefined : typeof item.condition === 'string' ? item.condition.trim() : null;
    if (!evtId || !paramName) errors.push(`${label}缺少 evtId 或 paramName`);
    else if (seen.has(`${evtId}.${paramName}`)) errors.push(`${label}重复`);
    seen.add(`${evtId}.${paramName}`);
    if (dataType === undefined && requiredRule === undefined && condition === undefined) errors.push(`${label}至少要改数据类型、必传规则或条件说明之一`);
    if (dataType !== undefined && !(OFFICIAL_PARAM_GOVERNANCE_TYPES as readonly unknown[]).includes(dataType)) {
      errors.push(`${label}数据类型只能是：${OFFICIAL_PARAM_GOVERNANCE_TYPES.join('、')}`);
    }
    if (requiredRule !== undefined && !(OFFICIAL_PARAM_GOVERNANCE_REQUIRED_RULES as readonly unknown[]).includes(requiredRule)) {
      errors.push(`${label}必传规则只能是：${OFFICIAL_PARAM_GOVERNANCE_REQUIRED_RULES.join('、')}`);
    }
    if (condition === null) errors.push(`${label}条件说明必须是文字`);
    if (typeof condition === 'string' && condition.length > MAX_TEXT_LENGTH) errors.push(`${label}条件说明超过 ${MAX_TEXT_LENGTH} 字`);
    if (!note) errors.push(`${label}缺少原因说明 note`);
    if (note.length > MAX_TEXT_LENGTH) errors.push(`${label}原因说明超过 ${MAX_TEXT_LENGTH} 字`);
    items.push({
      evtId, paramName, note,
      ...(dataType !== undefined ? { dataType: dataType as OfficialParamGovernanceItem['dataType'] } : {}),
      ...(requiredRule !== undefined ? { requiredRule: requiredRule as OfficialParamGovernanceItem['requiredRule'] } : {}),
      ...(typeof condition === 'string' ? { condition } : {}),
    });
  });
  if (errors.length) throw new TrackingWriteError(errors.join('\n'), 400);
  return { source: source as TrackingSource, dryRun, items };
}

function describeChange(
  before: { dataType: string; requiredRule: string; condition: string },
  after: { dataType: string; requiredRule: string; condition: string },
): string {
  const show = (value: string) => value || '空';
  return [
    before.dataType !== after.dataType ? `类型 ${show(before.dataType)}→${after.dataType}` : '',
    before.requiredRule !== after.requiredRule ? `必传 ${show(before.requiredRule)}→${after.requiredRule}` : '',
    before.condition !== after.condition ? '条件说明已更新' : '',
  ].filter(Boolean).join('，');
}

/** Plain-text cells may arrive as rich-text segments after the Base → D1 import; keep their line breaks. */
function plainText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? '')).join('').trim();
  return recordCellText(value).trim();
}
