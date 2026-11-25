import { tableNames } from './sync-table-labels';
import { Input } from '@client/src/components/ui/input';
import { toReadableError } from '@client/src/api/error';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@client/src/components/ui/button';
import { axiosForBackend } from '@client/src/api/http';
import type { DataSyncStatus } from '@shared/api.interface';
import { SyncTaskMonitor } from './SyncTaskMonitor';
import { OfficialGovernancePanel } from './OfficialGovernancePanel';

export default function DataSyncPage() {
  const [status, setStatus] = useState<DataSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseIds, setBaseIds] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const load = useCallback(async () => { try { setStatus((await axiosForBackend.get<DataSyncStatus>('/api/data-sync')).data); } catch (cause) { setError(toReadableError(cause, '加载失败').message); } }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 2000); return () => clearInterval(timer); }, [load]);
  const run = async (action: string, jobId?: number) => {
    setBusy(true); setError('');
    try {
      if (action === 'import') {
        let complete = false;
        while (!complete) { const response = await axiosForBackend.post<{ complete: boolean }>('/api/data-sync/import'); complete = response.data.complete; await load(); }
      } else {
        await axiosForBackend.post(`/api/data-sync/${action}`, jobId ? { jobId, baseId: baseIds[jobId] || '' } : undefined);
        if (action === 'run' || action === 'retry') void (async () => {
          for (let batch = 0; batch < 10; batch++) {
            const result = await axiosForBackend.post<{processed:number}>('/api/data-sync/dispatch');
            await load();
            if (result.data.processed < 50) break;
          }
        })().catch((cause) => setError(toReadableError(cause,'后台同步暂未完成，可在监控中查看').message));
      }
      await load();
    } catch (cause) { setError(toReadableError(cause, '操作失败').message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-lg font-semibold">数据同步</h1><p className="mt-1 text-sm text-muted-foreground">{!status ? '正在加载同步状态…' : status.mode === 'd1' ? 'D1 主读写 · Base 异步同步' : status?.mode === 'importing' ? '正在迁移，写入暂时冻结；离开后可继续迁移' : '当前读写 Feishu Base，尚未切换 D1'}</p></div><Button variant="outline" onClick={() => void load()}>刷新</Button></header>
    <section className="rounded-xl border border-border bg-card p-5"><h2 className="text-sm font-semibold">数据流向</h2><div className="my-5 flex flex-wrap items-center gap-3 text-sm"><span>App 编辑</span><span aria-hidden="true">→</span><span className="rounded-lg bg-accent px-4 py-3 text-accent-foreground">D1 保存</span><span aria-hidden="true">→</span><span>持久化同步待办</span><span aria-hidden="true">→</span><span>Feishu Base 查询</span></div><p className="mb-2 text-sm text-muted-foreground">首次迁移：Base → D1；切换后的持续同步：D1 → Base。</p><p className="text-sm leading-relaxed text-muted-foreground">保存成功表示数据已持久化到 D1，不等待 Base。Base 同步失败会保留待办。切换后请在 App 编辑；直接修改 Base 不会回流覆盖 D1。仅校验事件不会更新正式库。</p></section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <SyncTaskMonitor runs={status?.runs || []}
      actions={status?.canManage && <div className="flex flex-wrap gap-2">{status.mode !== 'd1' ? <Button disabled={busy} onClick={() => void run('import')}>{busy ? '迁移中…' : status.mode === 'importing' ? '继续迁移' : '导入并切换 D1'}</Button> : <><Button disabled={busy} onClick={() => void run('run')}>{busy ? '同步中…' : '开始同步'}</Button><Button variant="outline" disabled={busy} onClick={() => void run('retry')}>重试失败任务</Button></>}</div>}
      summary={<>{status?.queue.map((row) => <span key={row.status}>{({pending:'待同步',synced:'累计已同步',failed:'失败',processing:'执行中或结果待核对'} as Record<string,string>)[row.status] || row.status} {row.count}</span>)}{status && !status.queue.length && <span>暂无同步待办</span>}</>}
    >
    {!!status?.errors.length && <div className="space-y-3">{status.errors.map((row) => <div key={row.id} className="break-words text-sm text-destructive"><p>任务 {row.id} · {row.instance} · {row.error || '执行结果待核对，请管理员核对 Base 记录，禁止盲目重试新增操作'}</p>{status.canManage && row.status === 'processing' && row.instance !== '__notification' && <div className="mt-2 flex gap-2"><Input aria-label={`任务 ${row.id} 对应的 Base 记录 ID`} placeholder="核对后的 Base 记录 ID（rec…）" value={baseIds[row.id] || ''} onChange={(event) => setBaseIds((previous) => ({ ...previous, [row.id]: event.target.value }))} /><Button variant="outline" disabled={busy || !baseIds[row.id]} onClick={() => void run('reconcile', row.id)}>关联已有记录并恢复</Button></div>}</div>)}</div>}
    </SyncTaskMonitor>
    <section className="rounded-xl border border-border bg-card p-5"><h2 className="text-sm font-semibold">已迁移数据</h2><p className="mt-2 text-xs text-muted-foreground">{status?.migration ? `已读取 ${status.migration.count} 条记录，已完成 ${status.migration.index}/16 张表` : '尚未导入'}。迁移全部完成后才启用 D1。后台每五分钟恢复同步，积压期间 Base 查询可能滞后。</p><dl className="mt-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2">{status?.tables.map((row) => <div key={row.instance} className="flex justify-between border-b border-border py-2 text-sm"><dt>{tableNames[row.instance] || row.instance}</dt><dd className="tabular-nums">{row.count}</dd></div>)}</dl></section>
    {status?.canManage && status.mode === 'd1' && <OfficialGovernancePanel onApplied={() => void load()} />}
  </div>;
}
