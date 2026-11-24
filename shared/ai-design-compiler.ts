import { assertParameterContracts, officialParameterContract, GovernanceValidationError, type GovernanceSnapshot, type ReusePlan } from './official-first-workflow';

/** Model output is a proposal. Only this boundary assembles inherited contracts. */
export function compileDesignResponse(raw: unknown, snapshot: GovernanceSnapshot, plan: ReusePlan): unknown {
  if (!isObject(raw) || !Array.isArray(raw.events)) return raw;
  return { ...raw, events: raw.events.map((event: unknown) => {
    if (!isObject(event) || typeof event.evtId !== 'string') return event;
    const id: string = event.evtId.trim().toLowerCase();
    if (!plan.decisions.some((decision) => decision.evtId.toLowerCase() === id && decision.decision === 'reuse')) return event;
    const contexts = snapshot.contexts.filter((context) => context.event.evtId.toLowerCase() === id);
    if (contexts.length !== 1) throw new GovernanceValidationError(`正式事件参数契约缺失或重复：${event.evtId}`);
    const context = contexts[0];
    assertParameterContracts(context.event.evtId, context.params);
    const formal = context.event;
    const metadata: Record<string, string> = {
      eventName: formal.eventName, eventDefinition: formal.eventDefinition || '', triggerTiming: formal.triggerTiming || '',
      platform: formal.platform, handler: formal.handler || '', commonProps: formal.commonProps || '',
      version: formal.version, minVersion: formal.minVersion || '', metricScenario: formal.metricScenario || '',
    };
    const compiled = inherit(event, metadata);
    if (!Array.isArray(event.params)) return compiled;
    return { ...compiled, params: event.params.map((param: unknown) => {
      if (!isObject(param)) return param;
      const official = context.params.find((item) => item.paramName === param.paramName && item.status !== '已废弃');
      if (!official) return param; // New/deprecated parameter checks remain the validator's responsibility.
      return inherit(param, officialParameterContract(official));
    }) };
  }) };
}

function inherit(proposal: Record<string, unknown>, contract: Record<string, string>): Record<string, unknown> {
  const notes: string[] = typeof proposal.requestNotes === 'string' && proposal.requestNotes ? [proposal.requestNotes] : [];
  const differences: string[] = [];
  for (const [field, value] of Object.entries(contract)) {
    // Missing fields are normal in the delta protocol, including formal empty values.
    if (typeof proposal[field] === 'string' && proposal[field].trim() !== value.trim()) {
      differences.push(field);
      notes.push(`AI 提议（${field}，待确认，不改变正式口径）：${proposal[field] || '（空）'}`);
    }
  }
  const uncertainties: string[] = Array.isArray(proposal.uncertainties)
    ? proposal.uncertainties.filter((value: unknown): value is string => typeof value === 'string') : [];
  if (differences.length) uncertainties.push(`已保留正式契约；AI 差异待确认：${differences.join('、')}`);
  return { ...proposal, ...contract, requestNotes: [...new Set(notes)].join('\n'), uncertainties: [...new Set(uncertainties)] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
