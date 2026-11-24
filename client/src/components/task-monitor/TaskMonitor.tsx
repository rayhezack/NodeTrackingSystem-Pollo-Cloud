import { useEffect, useId, useState } from 'react';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { KubaiIcon } from '../kubai/KubaiIcon';
import { formatDuration, taskDuration, type MonitorRun, type MonitorTask } from './task-monitor-state';
import './task-monitor.css';

interface TaskMonitorProps {
  run: MonitorRun;
  onViewResult?: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onPause?: () => void;
  onResume?: () => void;
}
const STATUS = { pending: '等待中', running: '进行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已停止' };

export function TaskMonitor({ run, onViewResult, onRetry, onStop, stopping, onPause, onResume }: TaskMonitorProps) {
  const [now, setNow] = useState(Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pointed, setPointed] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const bodyId = useId();
  const detailId = useId();
  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'queued') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run.status]);
  const ended: number = run.endedAt ?? now;
  const totalTime: number = Math.max(0, ended - run.startedAt);
  const completed: MonitorTask[] = run.tasks.filter((task) => task.status === 'completed');
  const active: MonitorTask[] = run.tasks.filter((task) => task.status === 'running');
  const current: MonitorTask | undefined = [...active].reverse().find((task) => task.id.startsWith('event:')) || active[0] || run.tasks.find((task) => task.status === 'paused');
  const steps: MonitorTask[] = run.tasks.filter((task) => task.id.startsWith('phase:'));
  const activeStep: MonitorTask | undefined = steps.find((task) => task.status === 'running' || task.status === 'paused');
  const eventTasks: MonitorTask[] = run.tasks.filter((task) => task.id.startsWith('event:'));
  const failed: MonitorTask | undefined = run.tasks.find((task) => task.status === 'failed');
  const inspected: MonitorTask | undefined = run.tasks.find((task) => task.id === (pointed || pinned));
  const [confirmStop, setConfirmStop] = useState(false);
  const status: string = run.status === 'completed' ? '已完成' : run.status === 'failed' ? '任务失败' : run.status === 'cancelled' ? '已停止' : run.status === 'paused' ? '已暂停' : run.status === 'queued' ? '排队中' : '运行中';
  const summary: string = run.summary || (current?.detail ?? '正在建立任务连接');
  const showTask = (task: MonitorTask, row = false) => {
    const duration = taskDuration(task, ended);
    return <button key={task.id} type="button" className={row ? 'tm-task-row' : 'tm-segment'}
      data-state={task.status} data-selected={inspected?.id === task.id || undefined}
      aria-label={`${task.label}，${STATUS[task.status]}${duration == null ? '' : `，耗时 ${formatDuration(duration)}`}`}
      aria-expanded={inspected?.id === task.id} aria-controls={detailId}
      onPointerEnter={() => setPointed(task.id)} onFocus={() => setPointed(task.id)}
      onClick={() => { setPinned(pinned === task.id ? null : task.id); setPointed(null); }}>
      {row && <><TaskMark task={task} /><span className="tm-task-label">{task.label}</span>
        <span className="tm-task-status">{STATUS[task.status]}</span><time>{duration == null ? '—' : formatDuration(duration)}</time></>}
    </button>;
  };
  return <section className="task-monitor" data-state={run.status} aria-label="Task Monitor 埋点设计任务监控"
    onPointerLeave={() => setPointed(null)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPointed(null); }}>
    <header className="tm-header">
      <span className="tm-brand-icon"><KubaiIcon name="剪贴板" size={28} /></span>
      <div className="tm-heading"><h3>Task Monitor</h3><p>AI 埋点设计<span> · {run.tasks.filter((task) => task.id.startsWith('event:')).length || 0} 个事件</span></p></div>
      <time className="tm-total" title="从任务创建到当前的历时，包含排队与暂停" aria-label={`总历时 ${formatDuration(totalTime)}`}>{formatDuration(totalTime)}</time>
      <span className="tm-badge"><i />{status}</span>
      <button type="button" className="tm-icon-button" aria-label={collapsed ? '展开任务监控' : '收起任务监控'} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </header>
    {!collapsed && <div id={bodyId} className="tm-body">
      <div className="tm-current" role="status" aria-live="polite">
        {run.status === 'completed' ? <><span className="tm-done-mark"><Check size={16} /></span><div><b>初稿已就绪</b><p>{run.summary}</p></div></>
          : run.status === 'queued' ? <><span className="tm-current-icon"><KubaiIcon name="时钟" size={24} /></span><div><b>等待后台执行</b><p>{run.summary}</p></div></>
          : run.status === 'paused' ? <><span className="tm-current-icon"><KubaiIcon name="时钟" size={24} /></span><div><b>任务已暂停</b><p>{run.summary}</p></div></>
          : run.status === 'cancelled' ? <><span className="tm-error-mark"><X size={16} /></span><div><b>任务已停止</b><p>{run.summary}</p></div></>
          : run.status === 'failed' ? <><span className="tm-error-mark"><X size={16} /></span><div><b>{failed?.label || '任务未完成'}</b><p>{run.summary}</p></div></>
            : <><span className="tm-current-icon"><KubaiIcon name={current?.icon || '时钟'} size={24} /></span><div><b>{current?.label || '准备生成'}</b><p>{active.filter((task) => task.id.startsWith('event:')).length > 1 ? '多个事件并行设计中' : summary}</p></div>
              <time>{current && taskDuration(current, ended) != null ? formatDuration(taskDuration(current, ended)!) : '0:00'}</time></>}
      </div>
      <p className="tm-step-caption">{activeStep ? `阶段 ${steps.indexOf(activeStep) + 1}/${steps.length} · ${activeStep.label}` : status}<span>{eventTasks.length ? `事件 ${eventTasks.filter((task) => task.status === 'completed').length}/${eventTasks.length}` : `已完成 ${completed.length}/${run.tasks.length} 项`}</span></p>
      <div className="tm-track" aria-label="任务步骤，悬停或选择可查看详情" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(4px, 1fr))` }}>
        {steps.map((task) => showTask(task))}
      </div>
      {inspected && <div id={detailId} className="tm-detail">
        <div className="tm-detail-title"><KubaiIcon name={inspected.icon} size={24} /><b>{inspected.label}</b>
          <button type="button" className="tm-icon-button" aria-label="关闭任务详情" onClick={() => { setPinned(null); setPointed(null); }}><X size={13} /></button></div>
        <dl><div><dt>开始</dt><dd>{inspected.startedAt == null ? '尚未开始' : `+${formatDuration(inspected.startedAt - run.startedAt)}`}</dd></div>
          <div><dt>耗时</dt><dd>{taskDuration(inspected, ended) == null ? '—' : formatDuration(taskDuration(inspected, ended)!)}</dd></div>
          <div><dt>状态</dt><dd>{STATUS[inspected.status]}</dd></div>
          <div><dt>尝试</dt><dd>{inspected.attempt || (inspected.startedAt == null ? '—' : 1)}</dd></div></dl>
        <p>{inspected.detail}</p>
      </div>}
      {!inspected && !expanded && completed.length > 0 && <div className="tm-recent">{completed.slice(-2).reverse().map((task) => showTask(task, true))}</div>}
      {expanded && <div className="tm-task-list" aria-label="全部任务">{run.tasks.map((task) => showTask(task, true))}</div>}
      {(run.status === 'running' || run.status === 'queued' || run.status === 'paused') && onStop && confirmStop && <div className="tm-detail" role="alert">
        <p>停止后将中断本次生成。离开页面无需停止任务。</p>
        <button type="button" className="tm-text-button" onClick={() => setConfirmStop(false)}>继续运行</button>
        <button type="button" className="tm-result" disabled={stopping} onClick={onStop}>{stopping ? '停止中…' : '确认停止任务'}</button>
      </div>}
      <footer className="tm-footer">
        {(run.status === 'running' || run.status === 'queued') && <button type="button" className="tm-text-button" disabled={!onPause || stopping} onClick={onPause}>Ⅱ 暂停</button>}
        {run.status === 'paused' && <button type="button" className="tm-result" disabled={!onResume || stopping} onClick={onResume}>继续运行</button>}
        {(run.status === 'running' || run.status === 'queued' || run.status === 'paused') && <button type="button" className="tm-text-button" disabled={!onStop || stopping} onClick={() => setConfirmStop(!confirmStop)}>× 取消</button>}
        <button type="button" className="tm-text-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起任务' : '全部任务'}{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
        <span className="tm-count">{completed.length}/{run.tasks.length} 已完成</span>
        {run.status === 'completed' && onViewResult && <button type="button" className="tm-result" onClick={onViewResult}>查看草稿 <span aria-hidden="true">↗</span></button>}
        {run.status === 'failed' && onRetry && <button type="button" className="tm-result" onClick={onRetry}>重新生成</button>}
        {(run.status === 'running' || run.status === 'queued') && <span className="tm-live"><i />实时更新</span>}
      </footer>
    </div>}
  </section>;
}

function TaskMark({ task }: { task: MonitorTask }) {
  return <span className="tm-row-mark" data-state={task.status}>{task.status === 'completed' ? <Check size={12} />
    : task.status === 'failed' ? <X size={12} /> : <span className="tm-row-dot" />}</span>;
}
