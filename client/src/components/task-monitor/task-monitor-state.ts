import type { AiTrackingGenerationProgress, AiTrackingGenerationTask } from '@shared/api.interface';
import type { ProductIconName } from '../kubai/KubaiIcon';

export interface MonitorTask {
  id: string;
  label: string;
  icon: ProductIconName;
  status: AiTrackingGenerationTask['status'];
  detail: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  attempt?: number;
}
export interface MonitorRun {
  startedAt: number;
  endedAt?: number;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  tasks: MonitorTask[];
  summary?: string;
}
const phases: Array<{ id: string; label: string; icon: ProductIconName; detail: string }> = [
  { id: 'requirement', label: '读取需求', icon: '文档', detail: '读取需求单并核验当前用户的设计权限。' },
  { id: 'prd', label: '阅读 PRD', icon: '书本', detail: '使用已授权的飞书账号读取 PRD 正文与补充上下文。' },
  { id: 'governance', label: '读取正式库', icon: '文件夹', detail: '完整读取当前端的正式事件、参数、公共属性与枚举。' },
  { id: 'planning', label: '规划复用', icon: '灯泡', detail: '依据埋点设计 Skill，对照正式库决定复用、扩展或新增。' },
  { id: 'design', label: '设计事件与参数', icon: '编辑', detail: '逐事件生成设计增量，并校验正式参数契约。' },
  { id: 'validation', label: '统一校验', icon: '盾牌', detail: '核对全部规划事件、参数及正式库复用规则。' },
  { id: 'saving', label: '保存初稿', icon: '剪贴板', detail: '保存已校验的草稿，供人工评审后确认录入需求单。' },
];

export function startMonitor(startedAt: number, restored = false): MonitorRun {
  return { startedAt, status: 'running', tasks: restored
    ? [{ id: 'phase:background', label: '后台生成', icon: '时钟', status: 'running', detail: '已恢复后台任务；此前各步骤耗时未记录。', startedAt }]
    : phases.map((phase) => ({ ...phase, id: `phase:${phase.id}`, status: 'pending' })) };
}

export function advanceMonitor(run: MonitorRun, progress: AiTrackingGenerationProgress, receivedAt: number): MonitorRun {
  if (run.status !== 'running') return run;
  const at: number = progress.elapsedMs == null ? receivedAt : run.startedAt + progress.elapsedMs;
  const tasks: MonitorTask[] = run.tasks.map((task) => ({ ...task }));
  const stage: string = progress.stage === 'design_repair' ? 'design' : progress.stage;
  const index: number = tasks.findIndex((task) => task.id === `phase:${stage}`);
  if (index >= 0) {
    tasks.forEach((task, i: number) => {
      if (i < index && task.id.startsWith('phase:') && task.status === 'running') {
        task.status = 'completed'; task.endedAt = at;
      }
    });
    const task: MonitorTask = tasks[index];
    if (task.status === 'pending') { task.status = 'running'; task.startedAt = at; }
    if (!progress.task && progress.message) task.detail = progress.message;
  }
  if (progress.task) {
    const update: AiTrackingGenerationTask = progress.task;
    const prior: MonitorTask | undefined = tasks.find((task) => task.id === update.id);
    if (prior?.status === 'completed' || prior?.status === 'failed' || prior?.status === 'cancelled') return { ...run, tasks };
    const next: MonitorTask = { ...(prior || { id: update.id, icon: '文档' as const }), label: update.label,
      status: update.status, detail: update.detail || prior?.detail || '', attempt: update.attempt ?? prior?.attempt };
    if (update.status === 'running' && next.startedAt == null) next.startedAt = at;
    if (['completed', 'failed', 'cancelled'].includes(update.status)) {
      next.endedAt = at; next.durationMs = update.durationMs;
    }
    if (prior) tasks[tasks.indexOf(prior)] = next;
    else {
      const before: number = tasks.findIndex((task) => task.id === 'phase:validation');
      tasks.splice(before < 0 ? tasks.length : before, 0, next);
    }
  }
  return { ...run, tasks };
}

export function finishMonitor(run: MonitorRun, status: MonitorRun['status'], endedAt: number, summary: string): MonitorRun {
  return { ...run, status, endedAt, summary, tasks: run.tasks.map((task) => task.status === 'running'
    ? { ...task, endedAt, status: status === 'paused' ? 'paused' : status === 'completed' ? 'completed' : status === 'failed' && task.id.startsWith('phase:') ? 'failed' : 'cancelled',
      detail: status === 'failed' && task.id.startsWith('phase:') ? summary : task.detail }
    : { ...task, status: task.status === 'pending' && status !== 'completed' && status !== 'paused' ? 'cancelled' : task.status }) };
}

export function taskDuration(task: MonitorTask, now: number): number | undefined {
  return task.durationMs ?? (task.startedAt == null ? undefined : Math.max(0, (task.endedAt ?? now) - task.startedAt));
}

export function formatDuration(ms: number): string {
  const seconds: number = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
