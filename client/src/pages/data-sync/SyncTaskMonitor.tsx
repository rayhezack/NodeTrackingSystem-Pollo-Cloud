import { tableNames } from './sync-table-labels';
import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Loader2,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { axiosForBackend } from '@client/src/api/http';
import { toReadableError } from '@client/src/api/error';
import { Button } from '@client/src/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { RefreshCw } from '@client/src/components/kubai/product-icons';
import type {
  DataSyncRun,
  DataSyncRunDetail,
  DataSyncRunItem,
} from '@shared/api.interface';

const labels = {
  queued: '排队中',
  running: '同步中',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  pending: '待处理',
};
const colors = {
  pending: 'bg-muted-foreground/15',
  running: 'bg-primary',
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  blocked: 'bg-amber-500',
};
const duration = (start: number, end: number) =>
  `${Math.floor(Math.max(0, end - start) / 60000)}:${String(Math.floor(Math.max(0, end - start) / 1000) % 60).padStart(2, '0')}`;

export function SyncTaskMonitor({ runs }: { runs: DataSyncRun[] }) {
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [inspected, setInspected] = useState<DataSyncRunItem | null>(null);
  const [now, setNow] = useState(Date.now());
  const id =
    selected && runs.some((run) => run.id === selected)
      ? selected
      : runs[0]?.id;
  const query = useQuery({
    queryKey: ['sync-run', id, page, filter],
    enabled: Boolean(id),
    refetchInterval: 2000,
    queryFn: async () =>
      (
        await axiosForBackend.get<DataSyncRunDetail>(
          `/api/data-sync/runs/${id}`,
          { params: { page, status: filter } },
        )
      ).data,
  });
  const run = query.data?.run || runs.find((item) => item.id === id);
  useEffect(() => {
    if (!run || !['running', 'queued'].includes(run.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);
  useEffect(() => setInspected(null), [id, page, filter]);
  if (!run) return null;
  const finished = run.completed + run.failed;
  const groups = [
    { state: 'completed', count: run.completed },
    { state: 'failed', count: run.failed },
    { state: 'running', count: run.running },
    { state: 'pending', count: run.pending },
  ] as const;
  const activeItem =
    inspected &&
    query.data?.items.find((item) => item.jobId === inspected.jobId);
  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card"
      aria-label="Task Monitor 数据同步任务监控"
    >
      <header className="flex flex-wrap items-center gap-3 p-5">
        <RefreshCw className="size-7" />
        <div className="mr-auto">
          <h2 className="text-sm font-semibold">Task Monitor</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            数据同步 · {run.total} 条任务 ·{' '}
            {run.trigger === 'manual' ? '手动启动' : '自动启动'}
          </p>
        </div>
        <time className="font-mono text-sm">
          {duration(run.startedAt, run.finishedAt || now)}
        </time>
        <span
          className={`rounded-md px-2 py-1 text-xs ${run.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : run.status === 'blocked' ? 'bg-amber-50 text-amber-800' : 'bg-primary-soft text-primary'}`}
        >
          {labels[run.status]}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={expanded ? '收起同步监控' : '展开同步监控'}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </header>
      {expanded && (
        <div className="space-y-4 border-t border-border p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {run.status === 'completed'
                ? run.total
                  ? '本轮同步已完成'
                  : '当前没有待同步任务'
                : run.error ||
                  (run.running ? '正在写入 Base' : '等待后台继续处理')}
            </span>
            <span className="tabular-nums text-muted-foreground">
              已处理 {finished}/{run.total}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="本轮同步处理进度"
            aria-valuemin={0}
            aria-valuemax={run.total || 1}
            aria-valuenow={finished}
            className="flex h-2.5 gap-1 overflow-hidden rounded-full bg-muted"
          >
            {groups
              .filter((group) => group.count > 0)
              .map((group) => (
                <div
                  key={group.state}
                  title={`${labels[group.state]} ${group.count}`}
                  className={`min-w-1 rounded-full ${colors[group.state]}`}
                  style={{
                    width: `${(group.count / Math.max(1, run.total)) * 100}%`,
                  }}
                />
              ))}
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            {groups.map((group) => (
              <span key={group.state} className="flex items-center gap-1.5">
                <i className={`size-2 rounded-full ${colors[group.state]}`} />
                {group.state === 'failed'
                  ? '失败/阻塞'
                  : labels[group.state]}{' '}
                {group.count}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Select
              value={id}
              onValueChange={(value) => {
                setSelected(value);
                setPage(0);
              }}
            >
              <SelectTrigger aria-label="选择同步运行" className="w-64 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {runs.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {new Date(item.startedAt).toLocaleString('zh-CN')} ·{' '}
                    {labels[item.status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filter}
              onValueChange={(value) => {
                setFilter(value);
                setPage(0);
              }}
            >
              <SelectTrigger
                aria-label="筛选同步任务状态"
                className="w-36 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部任务</SelectItem>
                {Object.entries(labels)
                  .filter(([key]) =>
                    [
                      'pending',
                      'running',
                      'completed',
                      'failed',
                      'blocked',
                    ].includes(key),
                  )
                  .map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {query.error && (
            <p role="alert" className="text-sm text-destructive">
              {toReadableError(query.error, '监控读取失败').message}
            </p>
          )}
          {query.isPending && (
            <p className="text-xs text-muted-foreground">读取任务明细…</p>
          )}
          <div
            className="max-h-80 space-y-1 overflow-y-auto"
            aria-label="本轮同步任务明细"
          >
            {query.data?.items.map((item) => (
              <button
                key={item.jobId}
                type="button"
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent ${activeItem?.jobId === item.jobId ? 'bg-accent' : ''}`}
                onPointerEnter={() => setInspected(item)}
                onFocus={() => setInspected(item)}
                onClick={() =>
                  setInspected(activeItem?.jobId === item.jobId ? null : item)
                }
                aria-expanded={activeItem?.jobId === item.jobId}
              >
                <span
                  className={
                    item.status === 'completed'
                      ? 'text-emerald-600'
                      : item.status === 'failed' || item.status === 'blocked'
                        ? 'text-destructive'
                        : 'text-primary'
                  }
                >
                  {item.status === 'completed' ? (
                    <Check size={15} />
                  ) : item.status === 'running' ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : item.status === 'failed' || item.status === 'blocked' ? (
                    <X size={15} />
                  ) : (
                    <Circle size={13} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {tableNames[item.instance] || item.instance} ·{' '}
                    {
                      {
                        create: '新增',
                        update: '更新',
                        delete: '删除',
                        notification: '流程通知',
                      }[item.operation]
                    }
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {labels[item.status]}
                </span>
                <time className="w-12 text-right font-mono text-xs text-muted-foreground">
                  {item.startedAt
                    ? duration(item.startedAt, item.finishedAt || now)
                    : '—'}
                </time>
              </button>
            ))}
          </div>
          {activeItem && (
            <div className="space-y-2 rounded-lg bg-muted/60 p-4 text-xs leading-5">
              <div className="flex justify-between gap-2">
                <b className="break-words">
                  任务 {activeItem.jobId} · {activeItem.label}
                </b>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="关闭同步任务详情"
                  onClick={() => setInspected(null)}
                >
                  <X size={13} />
                </Button>
              </div>
              <p className="break-all">
                {activeItem.instance} · {activeItem.recordId}
              </p>
              <p>
                状态：{labels[activeItem.status]} · 尝试：{activeItem.attempts}
              </p>
              {activeItem.error && (
                <p className="break-words text-destructive">
                  {activeItem.error}
                </p>
              )}
            </div>
          )}
          <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>离开页面不停止任务 · 最近 10 次运行</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <span>
                {page + 1} /{' '}
                {Math.max(1, Math.ceil((query.data?.totalItems || 0) / 25))}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={(page + 1) * 25 >= (query.data?.totalItems || 0)}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </footer>
        </div>
      )}
    </section>
  );
}
