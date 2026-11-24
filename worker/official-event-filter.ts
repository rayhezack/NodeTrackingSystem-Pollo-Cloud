import type { BitableFilter } from './feishu-bitable';

// Keep legacy link-only parameter rows as well as rows identified by evt_id.
export function officialEventParamFilter(recordId: string, evtId: string): BitableFilter {
  return {
    conjunction: 'or',
    conditions: [
      { field_name: '关联事件', operator: 'contains', value: [recordId] },
      ...(evtId ? [{ field_name: 'evt_id', operator: 'is', value: [evtId] }] : []),
    ],
  };
}

export function officialEventIdFilter(evtId: string): BitableFilter {
  return { conjunction: 'and', conditions: [{ field_name: 'evt_id', operator: 'is', value: [evtId] }] };
}
