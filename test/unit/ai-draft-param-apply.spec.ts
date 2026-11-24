import { webcrypto } from 'node:crypto';
import type { AiTrackingDraft, AiTrackingDraftEvent } from '../../shared/api.interface';
import { enforceGovernance, governanceReport, normalizeReusePlan, readGovernanceSnapshot } from '../../shared/official-first-workflow';
import { applyAiDraft, type D1PreparedStatement } from '../../worker/ai-tracking';
import { getOfficialGovernanceSnapshot } from '../../worker/query-library';
import { applyAiDraftEvents, TrackingWriteError } from '../../worker/tracking-write';

jest.mock('../../worker/query-library', () => ({ getOfficialGovernanceSnapshot: jest.fn() }));
jest.mock('../../worker/tracking-read', () => ({ getTrackingDetail: async () => ({ data: { source: 'web', permissions: { canEditDesign: true } } }) }));
jest.mock('../../worker/tracking-write', () => ({ applyAiDraftEvents: jest.fn(), TrackingWriteError: class extends Error {} }));
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

async function fixture() {
  const snapshot = await readGovernanceSnapshot('web', async (table) => table === 'events'
    ? [{ id: 'formal', record: { evt_id: 'purchase_result', 事件中文名: '购买结果', 状态: '已上线', 端: 'Web' } }]
    : table === 'params' ? ['order_id', 'result', 'channel'].map((name) => ({ id: name, record: {
      evt_id: 'purchase_result', 参数名: name, 数据类型: 'STRING', 必传规则: '必传', 参数状态: '正式', 参数定义: name,
    } })) : table === 'commonProps' ? [{ id: 'page', record: { 属性名: 'page_name' } }]
      : [{ id: 'enum', record: { evt_id: 'purchase_result', 参数名: 'result', 枚举值: 'success' } }]);
  const plan = normalizeReusePlan({ primaryBoard: 'Agent', decisions: [{ evtId: 'purchase_result', decision: 'reuse', reason: '正式结果', comparedEventIds: ['purchase_result'] }] }, snapshot);
  const original: AiTrackingDraftEvent = { clientId: 'e1', evtId: 'purchase_result', eventName: '购买结果', eventDefinition: '',
    triggerTiming: '', metricScenario: '', priority: 'P1', platform: 'Web', handler: '服务端', commonProps: '', version: '1', minVersion: '1', changeType: '修改', evidence: [], uncertainties: [], params: [] };
  const events = enforceGovernance([original], snapshot, plan);
  const draft: AiTrackingDraft = { id: 'draft', recordId: 'web:rec', version: 1, status: 'draft', createdAt: Date.now(),
    provider: 'kimi', model: 'kimi-k3', prd: { url: 'https://example.com', truncated: false }, summary: '', analystQuestions: [],
    events, diffs: [], governance: governanceReport(snapshot, plan, events) };
  let payload = JSON.stringify(draft);
  const env = { DB: { prepare: (sql: string): D1PreparedStatement => {
    let values: unknown[] = [];
    const statement: D1PreparedStatement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async <T>() => ({ payload } as T),
      all: async () => ({ results: [] }),
      run: async () => { if (sql.startsWith('INSERT INTO ai_tracking_drafts')) payload = String(values[5]); return {}; },
    };
    return statement;
  } } };
  jest.mocked(getOfficialGovernanceSnapshot).mockResolvedValue(snapshot);
  jest.mocked(applyAiDraftEvents).mockImplementation(async (_env, _recordId, selected) => ({
    appliedRecordIds: ['web:rec'], createdEventCount: selected.length,
    createdParamCount: selected.reduce((count, item) => count + item.params.length, 0),
  }));
  return env;
}

describe('Pollo Cloud parameter apply boundary', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([['order_id', 'result'], []])('writes exactly the requested subset %j, even when governance inherits all formal parameters', async (...names: string[]) => {
    const env = await fixture();
    const request = { selectedEventClientIds: ['e1'], selectedParamNamesByEvent: { e1: names } };
    const response = await applyAiDraft(env, 'owner', 'web:rec', 'draft', request);
    expect(jest.mocked(applyAiDraftEvents).mock.calls[0][2][0].params.map((param) => param.paramName)).toEqual(names);
    expect(response.createdParamCount).toBe(names.length);
    const retry = await applyAiDraft(env, 'owner', 'web:rec', 'draft', request);
    expect(retry.createdParamCount).toBe(names.length);
    expect(applyAiDraftEvents).toHaveBeenCalledTimes(1);
  });
  it('rejects an unknown parameter before writing', async () => {
    const env = await fixture();
    await expect(applyAiDraft(env, 'owner', 'web:rec', 'draft', { selectedParamNamesByEvent: { e1: ['unknown'] } })).rejects.toBeInstanceOf(TrackingWriteError);
    expect(applyAiDraftEvents).not.toHaveBeenCalled();
  });
});
