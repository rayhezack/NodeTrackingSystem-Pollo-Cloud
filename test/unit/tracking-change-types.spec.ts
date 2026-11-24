import { TRACKING_CHANGE_TYPES, PARAM_CHANGE_TYPES, normalizeTrackingChangeType, normalizeParamChangeType, classifyAiDraftChange } from '../../shared/api.interface';
import type { AiTrackingDraftEvent } from '../../shared/api.interface';
import { CHANGE_TYPE_OPTIONS } from '../../client/src/pages/tracking-detail/stage-config';
import { CHANGE_TYPE_OPTIONS as PARAM_OPTIONS } from '../../client/src/pages/tracking-detail/param-designer/param-constants';
import { selectAiDraftEvents } from '../../shared/ai-draft-selection';

const event: AiTrackingDraftEvent = { clientId: 'e1', evtId: 'purchase_result', eventName: '购买结果', eventDefinition: '', triggerTiming: '', metricScenario: '',
  priority: 'P1', platform: 'Web', handler: '', commonProps: '', version: '', minVersion: '', changeType: '修改', evidence: [], uncertainties: [],
  reuseSource: { recordId: 'web:formal', evtId: 'purchase_result', eventName: '购买结果', modificationSummary: '原样复用' },
  params: ['order_id', 'channel'].map((paramName, index) => ({ paramName, paramType: 'STRING', requiredRule: '非必传', triggerCondition: '', enumRange: '', definition: '', defaultValue: '', example: '', platform: 'Web通用', source: index ? 'ai' : 'official', uncertainties: [] })),
};

describe('canonical change types', () => {
  it('exposes four event types and three parameter types without redundant labels', () => {
    expect(TRACKING_CHANGE_TYPES).toEqual(['新增', '修改', '废弃', '仅校验']);
    expect(CHANGE_TYPE_OPTIONS).toEqual(TRACKING_CHANGE_TYPES.map((value) => ({ value, label: value })));
    expect(PARAM_CHANGE_TYPES).toEqual(['新增', '修改', '废弃']);
    expect(PARAM_OPTIONS).toEqual(PARAM_CHANGE_TYPES);
    expect(normalizeParamChangeType('仅校验')).toBe('修改');
  });
  it.each([['口径调整', '修改'], ['删除', '废弃'], ['不变', '修改'], ['仅开发校验', '仅校验'], ['开发校验', '仅校验'], ['不修改正式库', '仅校验'], ['仅校验不归档', '仅校验']])('maps legacy %s to %s', (value, expected) => {
    expect(normalizeTrackingChangeType(value)).toBe(expected);
  });
  it('classifies unchanged reuse, compatible deltas and new events separately', () => {
    expect(classifyAiDraftChange(event)).toBe('修改');
    expect(classifyAiDraftChange({ ...event, params: [event.params[0]] })).toBe('仅校验');
    expect(classifyAiDraftChange({ ...event, params: [{ ...event.params[0], source: 'official_modified' }] })).toBe('修改');
    expect(classifyAiDraftChange({ ...event, params: [], reuseSource: undefined })).toBe('新增');
  });
  it('reclassifies the final selected subset after governance, rather than copying the full-draft change type', () => {
    const selection = selectAiDraftEvents([event], { selectedParamNamesByEvent: { e1: ['order_id'] } });
    expect(selection.project([event])[0].changeType).toBe('仅校验');
    expect(selection.project([event])[0].params.map((param) => param.paramName)).toEqual(['order_id']);
    expect(selectAiDraftEvents([event], { selectedParamNamesByEvent: { e1: [] } }).project([event])[0].changeType).toBe('仅校验');
  });
});
