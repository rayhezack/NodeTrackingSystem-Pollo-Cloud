import { useState } from 'react';
import { Button } from '@client/src/components/ui/button';
import { Textarea } from '@client/src/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@client/src/components/ui/native-select';
import { axiosForBackend } from '@client/src/api/http';
import { toReadableError } from '@client/src/api/error';
import type { OfficialGovernanceResponse, OfficialParamGovernanceResponse, TrackingSource } from '@shared/api.interface';

type Target = 'event' | 'param';
type PreviewRow = { key: string; label: string; cells: string[]; note: string };

const TARGETS: Record<Target, { endpoint: string; noun: string; columns: string[]; example: string; hint: string }> = {
  event: {
    endpoint: '/api/query-library/governance', noun: '正式事件', columns: ['状态', '生命周期'],
    hint: '只改正式事件的「状态」「生命周期状态」。废弃请走废弃需求单。',
    example: `[
  { "evtId": "agent_type_expo", "status": "待治理", "note": "埋点日志 11/18 起两端停报，暂停复用，待研发确认" }
]`,
  },
  param: {
    endpoint: '/api/query-library/param-governance', noun: '正式参数', columns: ['数据类型', '必传规则', '条件说明'],
    hint: '只改正式参数的「数据类型」「必传规则」「条件说明」。改为条件必传时必须写条件说明。',
    example: `[
  { "evtId": "createflow_start", "paramName": "createflow_id", "requiredRule": "必传", "note": "7 天日志 100% 上报" }
]`,
  },
};

const change = (before: string, after: string) => (before === after ? after || '空' : `${before || '空'} → ${after}`);

function previewRows(target: Target, data: OfficialGovernanceResponse | OfficialParamGovernanceResponse): PreviewRow[] {
  if (target === 'event') {
    return (data as OfficialGovernanceResponse).changes.map((item) => ({
      key: item.evtId, label: item.evtId, note: item.reviewNote,
      cells: [change(item.before.status, item.after.status), change(item.before.lifecycleStatus, item.after.lifecycleStatus)],
    }));
  }
  return (data as OfficialParamGovernanceResponse).changes.map((item) => ({
    key: `${item.evtId}.${item.paramName}`, label: `${item.evtId}.${item.paramName}`, note: item.note,
    cells: [
      change(item.before.dataType, item.after.dataType),
      change(item.before.requiredRule, item.after.requiredRule),
      item.before.condition === item.after.condition ? item.after.condition || '空' : `改为：${item.after.condition}`,
    ],
  }));
}

/** Admin-only: correct official events' status/lifecycle or official parameters' type/required rule in D1. Always preview first; execute sends exactly the previewed batch. */
export function OfficialGovernancePanel({ onApplied }: { onApplied: () => void }) {
  const [target, setTarget] = useState<Target>('event');
  const [source, setSource] = useState<TrackingSource>('app');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ key: string; rows: PreviewRow[]; unchanged: string[] } | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const config = TARGETS[target];
  const key = `${target}\n${source}\n${text}`;
  const previewIsCurrent = preview?.key === key;

  const submit = async (dryRun: boolean) => {
    setBusy(true); setError(''); setDone('');
    try {
      let items: unknown;
      try { items = JSON.parse(text); } catch { throw new Error('批次内容不是合法的 JSON 数组'); }
      const { data } = await axiosForBackend.post<OfficialGovernanceResponse | OfficialParamGovernanceResponse>(config.endpoint, { source, dryRun, items });
      if (dryRun) setPreview({ key, rows: previewRows(target, data), unchanged: data.unchanged });
      else {
        setPreview(null);
        setDone(`已更新 ${data.changes.length} 个${config.noun}${data.unchanged.length ? `，${data.unchanged.length} 个无需改动` : ''}；Base 将通过同步待办更新`);
        onApplied();
      }
    } catch (cause) { setError(toReadableError(cause, dryRun ? '预览失败' : '执行失败').message); }
    finally { setBusy(false); }
  };

  return <section className="rounded-xl border border-border bg-card p-5">
    <h2 className="text-sm font-semibold">正式库治理</h2>
    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{config.hint}原因说明只在预览里显示，请自行留档。先预览，确认差异后再执行；整批校验，有一条不通过就全部不写。</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <NativeSelect aria-label="治理对象" value={target} onChange={(event) => { setTarget(event.target.value as Target); setPreview(null); }}>
        <NativeSelectOption value="event">事件状态</NativeSelectOption>
        <NativeSelectOption value="param">参数类型与必传</NativeSelectOption>
      </NativeSelect>
      <NativeSelect aria-label="正式库" value={source} onChange={(event) => setSource(event.target.value as TrackingSource)}>
        <NativeSelectOption value="app">App 正式库</NativeSelectOption>
        <NativeSelectOption value="web">Web 正式库</NativeSelectOption>
      </NativeSelect>
      <Button variant="outline" disabled={busy || !text.trim()} onClick={() => void submit(true)}>{busy && !previewIsCurrent ? '预览中…' : '预览'}</Button>
      <Button disabled={busy || !previewIsCurrent || !preview?.rows.length} onClick={() => void submit(false)}>
        {busy && previewIsCurrent ? '执行中…' : `确认执行${previewIsCurrent && preview ? `（${preview.rows.length} 条）` : ''}`}
      </Button>
    </div>
    <Textarea aria-label="治理批次" className="mt-3 min-h-40 font-mono text-xs" placeholder={config.example} value={text} onChange={(event) => setText(event.target.value)} />
    {error && <p role="alert" className="mt-3 whitespace-pre-line text-sm text-destructive">{error}</p>}
    {done && <p role="status" className="mt-3 text-sm">{done}</p>}
    {preview && previewIsCurrent && <div className="mt-4 overflow-x-auto">
      <p className="mb-2 text-xs text-muted-foreground">预览：{preview.rows.length} 条将修改{preview.unchanged.length ? `，${preview.unchanged.length} 条已是目标值（${preview.unchanged.join('、')}）` : ''}</p>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground"><tr>
          <th className="py-2 pr-4 font-medium">{target === 'event' ? '事件' : '参数'}</th>
          {config.columns.map((column) => <th key={column} className="py-2 pr-4 font-medium">{column}</th>)}
          <th className="py-2 font-medium">原因说明（不写入正式库）</th>
        </tr></thead>
        <tbody>{preview.rows.map((row) => <tr key={row.key} className="border-t border-border align-top">
          <td className="py-2 pr-4 font-mono text-xs">{row.label}</td>
          {row.cells.map((cell, index) => <td key={index} className="py-2 pr-4 whitespace-nowrap">{cell}</td>)}
          <td className="py-2 text-xs text-muted-foreground">{row.note}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
