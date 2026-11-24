import type { AiTrackingDraftEvent, ApplyAiTrackingDraftRequest } from '../../shared/api.interface';
import { selectAiDraftEvents } from '../../shared/ai-draft-selection';
import { allDraftParams, countDraftParams, updateParamSelection } from '../../client/src/components/draft-review/param-selection';
import { enforceGovernance, normalizeReusePlan, readGovernanceSnapshot } from '../../shared/official-first-workflow';

const event: AiTrackingDraftEvent = {
  clientId: 'e1', evtId: 'purchase_result', eventName: '购买结果', eventDefinition: '购买业务结果',
  triggerTiming: '服务端确认后', metricScenario: '购买转化', priority: 'P1', platform: 'Web', handler: '服务端',
  commonProps: '', version: '1', minVersion: '1', changeType: '修改', evidence: [], uncertainties: [],
  params: ['order_id', 'result', 'channel'].map((paramName) => ({ paramName, paramType: 'STRING',
    requiredRule: '必传', triggerCondition: '', enumRange: '', definition: '正式业务参数', defaultValue: '',
    example: '', platform: 'Web通用', source: 'official', uncertainties: [] })),
};
const request = (names: string[]): ApplyAiTrackingDraftRequest => ({ selectedEventClientIds: ['e1'], selectedParamNamesByEvent: { e1: names } });

describe('AI draft parameter selection contract', () => {
  it('imports exactly two of three parameters without mutating the stored draft', () => {
    const selection = selectAiDraftEvents([event], request(['result', 'order_id']));
    expect(selection.events[0].params.map((param) => param.paramName)).toEqual(['order_id', 'result']);
    expect(event.params).toHaveLength(3);
    expect(selectAiDraftEvents([event], request([])).events[0].params).toEqual([]);
    expect(selectAiDraftEvents([event], {}).events[0].params).toHaveLength(3);
  });
  it.each([
    { selectedEventClientIds: ['unknown'] },
    { selectedEventClientIds: [] },
    { selectedEventClientIds: ['e1', 'e1'] },
    { selectedParamNamesByEvent: {} },
    { selectedParamNamesByEvent: { e1: ['result', 'result'] } },
    { selectedParamNamesByEvent: { e1: ['Result'] } },
    { selectedParamNamesByEvent: { e1: ['unknown'] } },
    { selectedParamNamesByEvent: { e1: [], other: [] } },
  ])('rejects stale or malformed selection %j before any write', (body) => {
    expect(() => selectAiDraftEvents([event], body)).toThrow();
  });
  it('does not let governance inheritance restore explicitly excluded official parameters', async () => {
    const snapshot = await readGovernanceSnapshot('web', async (table) => table === 'events'
      ? [{ id: 'official', record: { evt_id: event.evtId, 事件中文名: event.eventName, 状态: '已上线', 端: 'Web' } }]
      : table === 'params' ? event.params.map((param) => ({ id: param.paramName, record: {
        evt_id: event.evtId, 参数名: param.paramName, 数据类型: 'STRING', 必传规则: '必传', 参数状态: '正式', 参数定义: param.definition,
      } })) : table === 'commonProps' ? [{ id: 'page', record: { 属性名: 'page_name' } }] : [{ id: 'enum', record: { evt_id: event.evtId, 参数名: 'result', 枚举值: 'success' } }]);
    const plan = normalizeReusePlan({ primaryBoard: 'Agent', decisions: [{ evtId: event.evtId, decision: 'reuse', reason: '复用业务结果', comparedEventIds: [event.evtId] }] }, snapshot);
    const selection = selectAiDraftEvents([event], request(['order_id', 'result']));
    const governed = enforceGovernance(selection.events, snapshot, plan);
    expect(governed[0].params).toHaveLength(3);
    expect(selection.project(governed)[0].params.map((param) => param.paramName)).toEqual(['order_id', 'result']);
    expect(selectAiDraftEvents([event], request([])).project(governed)[0].params).toEqual([]);
  });
  it('scopes a shared parameter name to each selected event', () => {
    const second = { ...event, clientId: 'e2', evtId: 'another' };
    const result = selectAiDraftEvents([event, second], { selectedParamNamesByEvent: { e1: ['result'], e2: ['channel'] } });
    expect(result.events.map((item) => item.params.map((param) => param.paramName))).toEqual([['result'], ['channel']]);
  });
});

describe('review parameter controls', () => {
  it('selects all by default and bulk changes only the filtered scope', () => {
    const defaults = allDraftParams([event]);
    expect(defaults.e1).toEqual(['order_id', 'result', 'channel']);
    const chosen = updateParamSelection(event, defaults.e1, ['result'], false);
    expect(chosen).toEqual(['order_id', 'channel']);
    expect(updateParamSelection(event, chosen, ['result'], true)).toEqual(defaults.e1);
    expect(updateParamSelection(event, chosen, defaults.e1, false)).toEqual([]);
  });
  it('counts only selected events without clearing their retained parameter choices', () => {
    const params = { e1: ['order_id', 'result'] };
    expect(countDraftParams([event], new Set(['e1']), params)).toBe(2);
    expect(countDraftParams([event], new Set(), params)).toBe(0);
    expect(countDraftParams([event], new Set(['e1']), params)).toBe(2);
  });
});
