import { classifyAiDraftChange } from './api.interface';
import type { AiTrackingDraftEvent, ApplyAiTrackingDraftRequest } from './api.interface';

export class AiDraftSelectionError extends Error {
  constructor(message: string) { super(message); this.name = 'AiDraftSelectionError'; }
}
interface DraftSelection {
  events: AiTrackingDraftEvent[];
  /** Governance can inherit omitted official params; reapply the explicit allowlist before writing. */
  project(checked: AiTrackingDraftEvent[]): AiTrackingDraftEvent[];
}

export function selectAiDraftEvents(allEvents: AiTrackingDraftEvent[], request: ApplyAiTrackingDraftRequest): DraftSelection {
  const requested: unknown = request.selectedEventClientIds;
  const ids: string[] = requested === undefined ? allEvents.map((event) => event.clientId) : stringList(requested, '事件选择');
  if (!ids.length) throw new AiDraftSelectionError('至少选择一个埋点事件');
  const selected: Set<string> = new Set(ids);
  if (ids.some((id: string) => !allEvents.some((event) => event.clientId === id))) {
    throw new AiDraftSelectionError('所选事件不在当前草稿中，请刷新后重试');
  }
  const events: AiTrackingDraftEvent[] = allEvents.filter((event) => selected.has(event.clientId));
  const raw: unknown = request.selectedParamNamesByEvent;
  if (raw === undefined) return { events, project: (checked: AiTrackingDraftEvent[]) => checked };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AiDraftSelectionError('参数选择格式不正确');
  const choices: Record<string, unknown> = raw as Record<string, unknown>;
  if (Object.keys(choices).some((id: string) => !selected.has(id))) throw new AiDraftSelectionError('参数选择包含未选中的事件');
  const allowlist: Map<string, Set<string>> = new Map();
  for (const event of events) {
    if (!Object.prototype.hasOwnProperty.call(choices, event.clientId)) throw new AiDraftSelectionError(`${event.evtId} 缺少参数选择，请重新确认`);
    const names: string[] = stringList(choices[event.clientId], `${event.evtId} 参数选择`);
    const known: Set<string> = new Set(event.params.map((param) => param.paramName));
    if (names.some((name: string) => !known.has(name))) throw new AiDraftSelectionError(`${event.evtId} 所选参数不在当前草稿中`);
    allowlist.set(event.clientId, new Set(names));
  }
  const project = (checked: AiTrackingDraftEvent[]): AiTrackingDraftEvent[] => checked.map((event) => {
    const selected = { ...event, params: event.params.filter((param) => allowlist.get(event.clientId)?.has(param.paramName)) };
    return { ...selected, changeType: classifyAiDraftChange(selected) };
  });
  return { events: project(events), project };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string' || !item)) {
    throw new AiDraftSelectionError(`${label}格式不正确`);
  }
  const result: string[] = value as string[];
  if (new Set(result).size !== result.length) throw new AiDraftSelectionError(`${label}存在重复项`);
  return result;
}
