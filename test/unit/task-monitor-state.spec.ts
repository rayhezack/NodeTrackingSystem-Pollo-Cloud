import { advanceMonitor, finishMonitor, startMonitor, taskDuration } from '../../client/src/components/task-monitor/task-monitor-state';

describe('Task Monitor real progress', () => {
  it('closes stages only after a later server stage arrives and preserves elapsed time across heartbeats', () => {
    let run = startMonitor(1000);
    run = advanceMonitor(run, { stage: 'prd', message: '读取正文', elapsedMs: 100 }, 1100);
    run = advanceMonitor(run, { stage: 'prd', message: '读取正文', elapsedMs: 5100 }, 6100);
    expect(run.tasks.find((task) => task.id === 'phase:prd')?.startedAt).toBe(1100);
    expect(run.tasks[0].status).toBe('pending'); // No observed completion, no fabricated success.
    run = advanceMonitor(run, { stage: 'governance', message: '正式库', elapsedMs: 7100 }, 8100);
    const prd = run.tasks.find((task) => task.id === 'phase:prd')!;
    expect(prd.status).toBe('completed');
    expect(taskDuration(prd, 9000)).toBe(7000);
  });

  it('tracks parallel batches and retries independently without resetting task timers', () => {
    let run = startMonitor(0);
    for (const id of ['event:a', 'event:b']) {
      run = advanceMonitor(run, { stage: 'design', message: '设计', task: { id, label: id, status: 'running', attempt: 1 } }, 1000);
    }
    run = advanceMonitor(run, { stage: 'design_repair', message: '修正', task: { id: 'event:a', label: 'a', status: 'running', attempt: 2, detail: '类型校验失败，修正中' } }, 3000);
    expect(run.tasks.find((task) => task.id === 'event:a')).toMatchObject({ startedAt: 1000, attempt: 2, status: 'running' });
    run = advanceMonitor(run, { stage: 'design', message: '设计', task: { id: 'event:b', label: 'b', status: 'completed', durationMs: 2500 } }, 3500);
    expect(run.tasks.find((task) => task.id === 'event:a')?.status).toBe('running');
    expect(taskDuration(run.tasks.find((task) => task.id === 'event:b')!, 9000)).toBe(2500);
  });

  it('stays running until the actual result and rejects late progress after failure', () => {
    let run = advanceMonitor(startMonitor(0), { stage: 'saving', message: '保存' }, 100);
    expect(run.status).toBe('running');
    run = finishMonitor(run, 'failed', 200, '保存失败');
    expect(run.tasks.find((task) => task.id === 'phase:saving')?.status).toBe('failed');
    expect(run.tasks[0].status).toBe('cancelled');
    expect(advanceMonitor(run, { stage: 'saving', message: '迟到的数据' }, 300)).toBe(run);
  });

  it('keeps failed batches failed and freezes the final total duration', () => {
    let run = advanceMonitor(startMonitor(1000), { stage: 'design', message: '设计', task: { id: 'event:a', label: 'a', status: 'failed', durationMs: 400, detail: '校验失败' } }, 2000);
    run = finishMonitor(run, 'failed', 2500, '本次未完成');
    expect(run.endedAt).toBe(2500);
    expect(run.tasks.find((task) => task.id === 'event:a')?.status).toBe('failed');
    const restored = startMonitor(1000, true);
    expect(restored.tasks).toHaveLength(1);
    expect(restored.tasks[0].detail).toContain('未记录');
  });
});
