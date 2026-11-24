import { compileDesignResponse } from '../../shared/ai-design-compiler';
import { enforceGovernance, type GovernanceSnapshot, type ReusePlan } from '../../shared/official-first-workflow';
import type { AiTrackingDraftEvent, OfficialEvent, OfficialParam } from '../../shared/api.interface';

const official: OfficialEvent = { recordId: 'web:sub', source: 'web', evtId: 'sub_result', eventName: '订阅结果',
  platform: 'Web', version: '1', status: '已上线', paramLink: '', eventDefinition: '业务订阅结果', triggerTiming: '' };
const param: OfficialParam = { paramKey: 'sub_result.sub_result', paramName: 'sub_result', paramType: 'STRING',
  required: true, requiredRule: '条件必传', triggerCondition: '订阅结果返回时', definition: '结果', example: 'success',
  enumRange: 'success', platform: 'Web通用', status: '正式' };
const snapshot: GovernanceSnapshot = { source: 'web', events: [official], contexts: [{ event: official, params: [param] }],
  commonProps: [], enums: [], fingerprint: 'test', counts: { events: 1, params: 1, commonProps: 0, enums: 0 } };
const plan: ReusePlan = { primaryBoard: '付费链路', decisions: [{ evtId: 'sub_result', decision: 'reuse', reason: '已有业务结果', comparedEventIds: [] }] };
const event: AiTrackingDraftEvent = { clientId: 'test', evtId: 'sub_result', eventName: '', eventDefinition: '', triggerTiming: '',
  metricScenario: '', priority: 'P0', platform: 'Web', handler: '', commonProps: '', version: '', minVersion: '', changeType: '修改',
  evidence: [], uncertainties: [], params: [] };
const compile = (raw: unknown, library: GovernanceSnapshot = snapshot): { events: AiTrackingDraftEvent[] } =>
  compileDesignResponse(raw, library, plan) as { events: AiTrackingDraftEvent[] };

describe('AI design contract compiler', () => {
  it.each(['web', 'app'] as const)('hydrates minimal deltas from the %s snapshot before schema defaults', (source) => {
    const sourceEvent: OfficialEvent = { ...official, source, recordId: `${source}:sub`, platform: source === 'web' ? 'Web' : 'iOS、Android' };
    const library: GovernanceSnapshot = { ...snapshot, source, events: [sourceEvent], contexts: [{ event: sourceEvent, params: [param] }] };
    const result = compile({ events: [{ evtId: 'sub_result', params: [{ paramName: 'sub_result', enumRange: 'failed' }] }] }, library);
    expect(result.events[0]).toMatchObject({ eventName: official.eventName, platform: sourceEvent.platform, triggerTiming: '',
      params: [{ paramName: 'sub_result', paramType: 'STRING', requiredRule: '条件必传', triggerCondition: '订阅结果返回时', enumRange: 'failed' }] });
    expect(result.events[0].uncertainties).toEqual([]);
    expect(result.events[0].params[0].uncertainties).toEqual([]);
  });

  it.each(['paramType', 'requiredRule', 'triggerCondition', 'definition', 'example', 'platform', 'defaultValue'])(
    'never lets an AI-proposed %s overwrite the formal contract', (field: string) => {
      const input = { events: [{ ...event, params: [{ paramName: 'sub_result', [field]: '模型改写', enumRange: 'failed', requestNotes: '积分包补充' }] }] };
      const original: string = JSON.stringify(input);
      const compiled = compile(input);
      const checked = enforceGovernance(compiled.events, snapshot, plan);
      expect(checked[0].params[0]).toMatchObject({ paramType: 'STRING', requiredRule: '条件必传', triggerCondition: '订阅结果返回时',
        definition: '结果', example: 'success', platform: 'Web通用', defaultValue: '', enumRange: 'success\nfailed' });
      expect(checked[0].params[0].requestNotes).toContain(`AI 提议（${field}`);
      expect(checked[0].params[0].requestNotes).toContain('积分包补充');
      expect(checked[0].params[0].uncertainties.join(' ')).toContain('待确认');
      expect(JSON.stringify(input)).toBe(original);
      expect(compile(compiled)).toEqual(compiled);
      expect(enforceGovernance(checked, snapshot, plan)).toEqual(checked);
    });

  it.each(['', '正式条件'])('preserves exact formal condition %j when the model omits or clears it', (condition: string) => {
    const library: GovernanceSnapshot = { ...snapshot, contexts: [{ event: official, params: [{ ...param, triggerCondition: condition }] }] };
    for (const proposal of [{}, { triggerCondition: '' }, { triggerCondition: '本需求条件' }]) {
      expect(compile({ events: [{ evtId: 'sub_result', params: [{ paramName: 'sub_result', ...proposal }] }] }, library)
        .events[0].params[0].triggerCondition).toBe(condition);
    }
  });

  it('rejects contract tampering after compilation instead of recompiling at apply', () => {
    const checked = enforceGovernance(compile({ events: [{ ...event, params: [{ paramName: 'sub_result', enumRange: '' }] }] }).events, snapshot, plan);
    for (const change of [{ paramType: 'INTEGER' }, { requiredRule: '非必传' }, { triggerCondition: '' }]) {
      expect(() => enforceGovernance([{ ...checked[0], params: [{ ...checked[0].params[0], ...change }] }], snapshot, plan)).toThrow('冲突');
    }
  });

  it('preserves strict checks for new required parameters, deprecated params, and forged reuse sources', () => {
    const newlyRequired = compile({ events: [{ ...event, params: [{ paramName: 'new_param', paramType: 'STRING', requiredRule: '必传', uncertainties: [] }] }] });
    expect(() => enforceGovernance(newlyRequired.events, snapshot, plan)).toThrow('只能新增可选参数');
    const deprecated: GovernanceSnapshot = { ...snapshot, contexts: [{ event: official, params: [{ ...param, status: '已废弃' }] }] };
    expect(() => enforceGovernance(compile({ events: [{ ...event, params: [{ ...param, uncertainties: [] }] }] }, deprecated).events, deprecated, plan)).toThrow('已废弃');
    const forged = compile({ events: [{ ...event, reuseSource: { recordId: 'app:wrong', evtId: 'sub_result' } }] });
    expect(() => enforceGovernance(forged.events, snapshot, plan)).toThrow('来源');
  });

  it('rejects ambiguous official contracts regardless of row order', () => {
    for (const params of [[param, { ...param, triggerCondition: '冲突' }], [{ ...param, triggerCondition: '冲突' }, param]]) {
      const library: GovernanceSnapshot = { ...snapshot, contexts: [{ event: official, params }] };
      expect(() => compile({ events: [{ evtId: 'sub_result' }] }, library)).toThrow('正式参数定义冲突');
    }
  });
});
