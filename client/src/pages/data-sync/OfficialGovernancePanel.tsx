import { useState } from 'react';
import { Button } from '@client/src/components/ui/button';
import { Textarea } from '@client/src/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@client/src/components/ui/native-select';
import { axiosForBackend } from '@client/src/api/http';
import { toReadableError } from '@client/src/api/error';
import type { OfficialGovernanceResponse, TrackingSource } from '@shared/api.interface';

const EXAMPLE = `[
  { "evtId": "agent_type_expo", "status": "待治理", "note": "埋点日志 11/18 起两端停报，暂停复用，待研发确认" }
]`;

/** Admin-only: correct 状态 / 生命周期状态 of official events in D1. Always preview first; execute sends exactly the previewed batch. */
export function OfficialGovernancePanel({ onApplied }: { onApplied: () => void }) {
  const [source, setSource] = useState<TrackingSource>('app');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ key: string; result: OfficialGovernanceResponse } | null>(null);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = `${source}\n${text}`;
  const previewIsCurrent = preview?.key === key;

  const submit = async (dryRun: boolean) => {
    setBusy(true); setError(''); setDone('');
    try {
      let items: unknown;
      try { items = JSON.parse(text); } catch { throw new Error('批次内容不是合法的 JSON 数组'); }
      const { data } = await axiosForBackend.post<OfficialGovernanceResponse>('/api/query-library/governance', { source, dryRun, items });
      if (dryRun) setPreview({ key, result: data });
      else {
        setPreview(null);
        setDone(`已更新 ${data.changes.length} 个正式事件${data.unchanged.length ? `，${data.unchanged.length} 个无需改动` : ''}；Base 将通过同步待办更新`);
        onApplied();
      }
    } catch (cause) { setError(toReadableError(cause, dryRun ? '预览失败' : '执行失败').message); }
    finally { setBusy(false); }
  };

  return <section className="rounded-xl border border-border bg-card p-5">
    <h2 className="text-sm font-semibold">正式库状态治理</h2>
    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">只改正式事件的「状态」「生命周期状态」，原因会写入「最近评审记录」。废弃请走废弃需求单。先预览，确认差异后再执行；整批校验，有一条不通过就全部不写。</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <NativeSelect aria-label="正式库" value={source} onChange={(event) => setSource(event.target.value as TrackingSource)}>
        <NativeSelectOption value="app">App 正式库</NativeSelectOption>
        <NativeSelectOption value="web">Web 正式库</NativeSelectOption>
      </NativeSelect>
      <Button variant="outline" disabled={busy || !text.trim()} onClick={() => void submit(true)}>{busy && !previewIsCurrent ? '预览中…' : '预览'}</Button>
      <Button disabled={busy || !previewIsCurrent || !preview?.result.changes.length} onClick={() => void submit(false)}>
        {busy && previewIsCurrent ? '执行中…' : `确认执行${previewIsCurrent && preview ? `（${preview.result.changes.length} 条）` : ''}`}
      </Button>
    </div>
    <Textarea aria-label="治理批次" className="mt-3 min-h-40 font-mono text-xs" placeholder={EXAMPLE} value={text} onChange={(event) => setText(event.target.value)} />
    {error && <p role="alert" className="mt-3 whitespace-pre-line text-sm text-destructive">{error}</p>}
    {done && <p role="status" className="mt-3 text-sm">{done}</p>}
    {preview && previewIsCurrent && <div className="mt-4 overflow-x-auto">
      <p className="mb-2 text-xs text-muted-foreground">预览：{preview.result.changes.length} 条将修改{preview.result.unchanged.length ? `，${preview.result.unchanged.length} 条已是目标值（${preview.result.unchanged.join('、')}）` : ''}</p>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground"><tr><th className="py-2 pr-4 font-medium">事件</th><th className="py-2 pr-4 font-medium">状态</th><th className="py-2 pr-4 font-medium">生命周期</th><th className="py-2 font-medium">写入的评审记录</th></tr></thead>
        <tbody>{preview.result.changes.map((change) => <tr key={change.evtId} className="border-t border-border align-top">
          <td className="py-2 pr-4 font-mono text-xs">{change.evtId}</td>
          <td className="py-2 pr-4 whitespace-nowrap">{change.before.status === change.after.status ? change.after.status : `${change.before.status || '空'} → ${change.after.status}`}</td>
          <td className="py-2 pr-4 whitespace-nowrap">{change.before.lifecycleStatus === change.after.lifecycleStatus ? change.after.lifecycleStatus || '空' : `${change.before.lifecycleStatus || '空'} → ${change.after.lifecycleStatus}`}</td>
          <td className="py-2 text-xs text-muted-foreground">{change.reviewNote}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
