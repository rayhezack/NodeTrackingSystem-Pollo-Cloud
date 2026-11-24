import type { AiDraftParamSelection, AiTrackingDraftEvent } from '@shared/api.interface';

export function allDraftParams(events: AiTrackingDraftEvent[]): AiDraftParamSelection {
  return Object.fromEntries(events.map((event) => [event.clientId, event.params.map((param) => param.paramName)]));
}

/** Apply a bulk change only to its visible scope; preserve hidden choices and the draft's order. */
export function updateParamSelection(event: AiTrackingDraftEvent, selected: string[], scope: string[], checked: boolean): string[] {
  const next: Set<string> = new Set(selected);
  for (const name of scope) { if (checked) next.add(name); else next.delete(name); }
  return event.params.map((param) => param.paramName).filter((name: string) => next.has(name));
}

export function countDraftParams(events: AiTrackingDraftEvent[], selectedIds: Set<string>, params: AiDraftParamSelection): number {
  return events.filter((event) => selectedIds.has(event.clientId)).reduce((count: number, event) =>
    count + event.params.filter((param) => (params[event.clientId] || []).includes(param.paramName)).length, 0);
}
