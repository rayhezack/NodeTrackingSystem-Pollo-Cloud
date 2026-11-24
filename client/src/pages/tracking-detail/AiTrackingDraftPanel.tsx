import { startAiBackgroundJob, getLatestAiJob, getAiJob, stopAiJob, pauseAiJob, resumeAiJob, getAiJobResult } from '@client/src/api/ai-jobs';
import { FileCheck2, FileSearch, ExternalLink, RefreshCw, Sparkles } from '@client/src/components/kubai/product-icons';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Checkbox } from '@client/src/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  applyAiTrackingDraft,
  generateAiTrackingDraft,
  getAiFeishuAuthStatus,
  getAiTrackingDraft,
  getLatestAiTrackingDraft,
  getAiTrackingConfig,
  startAiFeishuAuth,
} from '@client/src/api/tracking';
import type {
  AiFeishuAuthStatus,
  AiTrackingConfigStatus,
  AiTrackingDraft,
  AiDraftParamSelection,
  AiTrackingJob,
  TrackingDetail,
} from '@shared/api.interface';
import { UploadDropzone, type UploadDocument } from '@client/src/components/bencho/UploadDropzone';
import { TaskMonitor } from '@client/src/components/task-monitor/TaskMonitor';
import { advanceMonitor, finishMonitor, startMonitor, type MonitorRun } from '@client/src/components/task-monitor/task-monitor-state';
import { allDraftParams, countDraftParams } from '@client/src/components/draft-review/param-selection';
import { getAiDraftGenerationBlockReason } from './ai-tracking-prd.utils';

const AiDraftReview = lazy(() => import('@client/src/components/draft-review/AiDraftReview').then((module) => ({ default: module.AiDraftReview })));

interface AiTrackingDraftPanelProps {
  detail: TrackingDetail;
  canEdit: boolean;
  actorId?: string;
  actorLarkId?: string;
  onApplied?: (recordId?: string) => void | Promise<void>;
}

const AiTrackingDraftPanel = ({
  detail,
  canEdit,
  actorId,
  actorLarkId,
  onApplied,
}: AiTrackingDraftPanelProps) => {
  const [config, setConfig] = useState<AiTrackingConfigStatus | null>(null);
  const [auth, setAuth] = useState<AiFeishuAuthStatus | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [draft, setDraft] = useState<AiTrackingDraft | null>(null);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [selectedParams, setSelectedParams] = useState<AiDraftParamSelection>({});
  const selectionDraftRef = useRef('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [job, setJob] = useState<AiTrackingJob | null>(null);
  const [stopping, setStopping] = useState(false);
  const [monitorRun, setMonitorRun] = useState<MonitorRun | null>(null);
  const generationAbortRef = useRef<AbortController | null>(null);
  const [applying, setApplying] = useState(false);
  const [contextFiles, setContextFiles] = useState<UploadDocument[]>([]);
  const [readingContext, setReadingContext] = useState(false);
  const pendingGenerateAfterAuthRef = useRef(false);
  const authWindowRef = useRef<Window | null>(null);
  const generationPollRef = useRef(0);

  const setActiveDraft = useCallback((nextDraft: AiTrackingDraft | null) => {
    setDraft(nextDraft);
    if (nextDraft?.status === 'generating') {
      setMonitorRun((previous) => previous || startMonitor(nextDraft.createdAt, true));
    } else if (nextDraft?.status === 'draft' || nextDraft?.status === 'failed') {
      setMonitorRun((previous) => previous?.status === 'running'
        ? finishMonitor(previous, nextDraft.status === 'failed' ? 'failed' : 'completed', Date.now(),
          nextDraft.status === 'failed' ? nextDraft.failureMessage || '生成失败，请重新生成' : `${nextDraft.events.length} 个事件 · ${nextDraft.events.reduce((count, event) => count + event.params.length, 0)} 个参数，待人工确认`)
        : previous);
    }
    const selectionKey: string = nextDraft ? `${nextDraft.id}:${nextDraft.status}` : '';
    if (selectionDraftRef.current !== selectionKey) {
      selectionDraftRef.current = selectionKey;
      setSelectedIds(new Set(nextDraft?.events.map((event) => event.clientId) || []));
      setSelectedParams(allDraftParams(nextDraft?.events || []));
    }
  }, []);

  const pollDraftGeneration = useCallback(async (draftId: string) => {
    const pollId = generationPollRef.current + 1;
    generationPollRef.current = pollId;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      if (generationPollRef.current !== pollId) return;
      try {
        const { draft: nextDraft } = await getAiTrackingDraft(detail.recordId, draftId, actorId, actorLarkId);
        if (generationPollRef.current !== pollId || !nextDraft) return;
        setActiveDraft(nextDraft);
        if (nextDraft.status !== 'generating') {
          if (nextDraft.status === 'failed') {
            toast.error(nextDraft.failureMessage || 'AI 埋点草稿生成失败');
          }
          return;
        }
      } catch {
        // A transient status-query failure should not cancel the background generation.
      }
    }
    toast.warning('AI 草稿仍在后台生成，请稍后重新打开需求单查看');
  }, [actorId, actorLarkId, detail.recordId, setActiveDraft]);

  const receiveJob = useCallback(async (next: AiTrackingJob, cancelled: () => boolean) => {
    if (cancelled()) return;
    setJob(next);
    let run: MonitorRun = startMonitor(next.createdAt);
    for (const entry of next.progress) run = advanceMonitor(run, entry, next.createdAt + (entry.elapsedMs || 0));
    if (next.status === 'queued') { run = { ...run, status: 'queued', summary: '任务已排队，后台将自动继续执行' }; }
    if (next.status === 'completed') {
      const { draft: result } = await getAiJobResult(next.id);
      if (cancelled()) return;
      setActiveDraft(result);
      run = finishMonitor(run, 'completed', next.updatedAt, `${result?.events.length || 0} 个事件，待人工确认`);
    } else if (next.status === 'paused') {
      run = finishMonitor(run, 'paused', next.updatedAt, '任务已暂停，已完成结果保留；继续后从检查点恢复');
    } else if (next.status === 'failed' || next.status === 'cancelled') {
      run = finishMonitor(run, next.status, next.updatedAt, next.status === 'cancelled' ? '已手动停止；已生成内容不会自动录入' : next.error || '后台任务失败');
    }
    if (!cancelled()) setMonitorRun(run);
  }, [setActiveDraft]);

  const watchJob = useCallback(async (initial: AiTrackingJob) => {
    const pollId: number = ++generationPollRef.current;
    const cancelled = () => generationPollRef.current !== pollId;
    let next: AiTrackingJob = initial;
    let failures = 0;
    while (!cancelled()) {
      try {
        await receiveJob(next, cancelled);
        if (!['queued', 'running'].includes(next.status)) return;
      } catch {
        failures += 1;
        if (failures === 3) toast.warning('草稿暂时读取失败，正在重试；后台结果已保留');
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      if (cancelled()) return;
      try { next = await getAiJob(initial.id); failures = 0; }
      catch {
        failures += 1;
        if (failures === 3) toast.warning('状态连接暂时中断，后台任务仍会继续运行');
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(15000, failures * 2500)));
      }
    }
  }, [receiveJob]);

  const refreshConfig = useCallback(async () => {
    const nextConfig = await getAiTrackingConfig();
    setConfig(nextConfig);
    return nextConfig;
  }, []);

  const refreshAuthStatus = useCallback(async () => {
    const nextAuth = await getAiFeishuAuthStatus(actorId, actorLarkId);
    setAuth(nextAuth);
    return nextAuth;
  }, [actorId, actorLarkId]);

  useEffect(() => {
    void Promise.all([refreshConfig(), refreshAuthStatus()]).catch(() => undefined);
  }, [refreshAuthStatus, refreshConfig]);

  useEffect(() => {
    let cancelled = false;
    setActiveDraft(null);
    if (!canEdit || !config) return () => { cancelled = true; };
    if (config.tokenStorage === 'encrypted_d1') {
      const initialPoll: number = generationPollRef.current;
      void getLatestAiJob(detail.recordId).then(async (latest) => {
        if (cancelled || initialPoll !== generationPollRef.current) return;
        if (latest) { void watchJob(latest); return; }
        const { draft: legacy } = await getLatestAiTrackingDraft(detail.recordId, actorId, actorLarkId);
        if (!cancelled && initialPoll === generationPollRef.current) setActiveDraft(legacy);
      }).catch(() => undefined);
      return () => { cancelled = true; generationPollRef.current += 1; };
    }
    void getLatestAiTrackingDraft(detail.recordId, actorId, actorLarkId)
      .then(({ draft: latestDraft }) => {
        if (cancelled || !latestDraft) return;
        setActiveDraft(latestDraft);
        if (latestDraft.status === 'generating') {
          void pollDraftGeneration(latestDraft.id);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [actorId, actorLarkId, canEdit, config, detail.recordId, pollDraftGeneration, setActiveDraft, watchJob]);

  useEffect(() => () => {
    generationPollRef.current += 1;
    generationAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setMonitorRun(null);
    setJob(null);
    setGenerationError('');
    return () => { generationPollRef.current += 1; generationAbortRef.current?.abort(); };
  }, [detail.recordId]);

  const performGenerate = useCallback(async () => {
    setLoading(true);
    setGenerationError('');
    setMonitorRun(startMonitor(Date.now()));
    if (config?.tokenStorage === 'encrypted_d1') {
      try {
        const next = await startAiBackgroundJob(detail.recordId, {
          contextFiles: contextFiles.map(({ name, content }) => ({ name, content })),
        });
        void watchJob(next);
      } catch (error) {
        const message: string = error instanceof Error ? error.message : '创建后台任务失败';
        setMonitorRun((previous) => previous ? finishMonitor(previous, 'failed', Date.now(), message) : previous);
        toast.error(message);
      } finally { setLoading(false); }
      return;
    }
    const abort = new AbortController();
    generationAbortRef.current = abort;
    try {
      const result = await generateAiTrackingDraft(detail.recordId, {
        actorId,
        actorLarkId,
        contextFiles: contextFiles.map(({ name, content }) => ({ name, content })),
      }, { signal: abort.signal, onProgress: (progress) => setMonitorRun((previous) => previous ? advanceMonitor(previous, progress, Date.now()) : previous) });
      if (abort.signal.aborted) return;
      setActiveDraft(result.draft);
      if (result.draft.status === 'generating') {
        setMonitorRun((previous) => previous?.tasks.every((task) => task.status === 'pending') ? startMonitor(previous.startedAt, true) : previous);
        void pollDraftGeneration(result.draft.id);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'AI 埋点草稿生成失败';
      setGenerationError(message);
      setMonitorRun((previous) => previous ? finishMonitor(previous, 'failed', Date.now(), message) : previous);
      toast.error(message);
    } finally {
      if (generationAbortRef.current === abort) {
        setLoading(false);
        generationAbortRef.current = null;
      }
    }
  }, [actorId, actorLarkId, config, contextFiles, detail.recordId, pollDraftGeneration, setActiveDraft, watchJob]);

  useEffect(() => {
    if (!authUrl || auth?.authorized || !authDialogOpen) return;
    const interval = window.setInterval(() => {
      void refreshAuthStatus().then((status) => {
        if (!status.authorized) return;
        authWindowRef.current?.close();
        authWindowRef.current = null;
        setAuthDialogOpen(false);
        setAuthUrl('');
        toast.success('飞书文档已授权，正在生成埋点初稿');
        if (pendingGenerateAfterAuthRef.current) {
          pendingGenerateAfterAuthRef.current = false;
          void performGenerate();
        }
      }).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [authUrl, auth?.authorized, authDialogOpen, performGenerate, refreshAuthStatus]);

  useEffect(() => () => authWindowRef.current?.close(), []);

  const handleAuthorizeAndGenerate = async () => {
    try {
      const popup = window.open('', 'feishu-ai-auth', 'width=520,height=720,resizable=yes,scrollbars=yes');
      const result = await startAiFeishuAuth({ recordId: detail.recordId, actorId, actorLarkId });
      setAuthUrl(result.authorizationUrl);
      setAuthDialogOpen(true);
      pendingGenerateAfterAuthRef.current = true;
      if (popup) {
        authWindowRef.current = popup;
        popup.location.href = result.authorizationUrl;
        popup.focus();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法发起飞书授权');
    }
  };

  const handleAuthDialogOpenChange = useCallback((open: boolean) => {
    setAuthDialogOpen(open);
    if (!open) {
      authWindowRef.current?.close();
      authWindowRef.current = null;
      setAuthUrl('');
      pendingGenerateAfterAuthRef.current = false;
    }
  }, []);

  const jobActive: boolean = job?.status === 'queued' || job?.status === 'running';
  const handleStop = async () => {
    if (!job || stopping) return;
    setStopping(true);
    try { await receiveJob(await stopAiJob(job.id), () => false); toast.success('后台任务已停止'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '停止失败，请重试'); }
    finally { setStopping(false); }
  };

  const handlePauseOrResume = async () => {
    if (!job || stopping) return;
    setStopping(true);
    try {
      if (job.status === 'paused') void watchJob(await resumeAiJob(job.id));
      else await receiveJob(await pauseAiJob(job.id), () => false);
    } catch (error) { toast.error(error instanceof Error ? error.message : '任务状态更新失败'); }
    finally { setStopping(false); }
  };

  const handleGenerate = async () => {
    if (readingContext) { toast.info('请等待上下文文件读取完成'); return; }
    if (draft?.status === 'generating' || jobActive || job?.status === 'paused') {
      toast.info('当前草稿仍在生成，请稍候');
      return;
    }
    const requirementLink = String(detail.requirementFields['需求链接'] || '').trim();
    const blockedReason = getAiDraftGenerationBlockReason(requirementLink);
    if (blockedReason) {
      toast.error(blockedReason);
      return;
    }
    const currentAuth = auth?.authorized ? auth : await refreshAuthStatus().catch(() => auth);
    if (!currentAuth?.authorized) {
      await handleAuthorizeAndGenerate();
      return;
    }
    await performGenerate();
  };

  const handleApply = async () => {
    if (!draft || !selectedIds.size) return;
    setApplying(true);
    try {
      const result = await applyAiTrackingDraft(detail.recordId, draft.id, {
        actorId,
        actorLarkId,
        selectedEventClientIds: Array.from(selectedIds),
        selectedParamNamesByEvent: Object.fromEntries(Array.from(selectedIds, (id: string) => [id, selectedParams[id] || []])),
      });
      toast.success(`已写入 ${result.createdEventCount} 个事件、${result.createdParamCount} 个参数`);
      setDraftDialogOpen(false);
      setActiveDraft(null);
      await onApplied?.(result.appliedRecordIds[0]);
    } catch (error) {
      const status = (error as Error & { status?: number })?.status;
      if (status !== 504) {
        toast.error(error instanceof Error ? error.message : 'AI 草稿应用失败');
        return;
      }

      const recoveredDraft = await waitForDraftCompletion(
        detail.recordId,
        draft.id,
        actorId,
        actorLarkId,
      );
      if (recoveredDraft?.status === 'applied') {
        const appliedRecordIds = recoveredDraft.appliedRecordIds || [];
        toast.success(
          `已写入 ${appliedRecordIds.length} 个事件、${recoveredDraft.appliedParamCount || 0} 个参数`,
        );
        setDraftDialogOpen(false);
        setActiveDraft(null);
        await onApplied?.(appliedRecordIds[0]);
      } else if (recoveredDraft?.status === 'failed') {
        toast.error(recoveredDraft.failureMessage || 'AI 草稿应用失败');
      } else {
        toast.warning('后台仍在录入，请稍后刷新需求单确认结果，期间请勿重复提交');
      }
    } finally {
      setApplying(false);
    }
  };

  const requirementLink = String(detail.requirementFields['需求链接'] || '').trim();
  const ready = Boolean(config?.configured && config.feishuOAuthConfigured);

  return (
    <>
      <div className="min-w-0 max-w-full overflow-hidden rounded-2xl bg-card px-4 py-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 max-w-full flex-1 items-center gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">AI 埋点初稿</span>
                {auth?.authorized && (
                  <Badge variant="outline" className="h-5 rounded-full border-emerald-200 px-1.5 text-xs font-normal text-emerald-700">
                    已授权
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 min-w-0 max-w-full truncate text-xs text-muted-foreground" title={requirementLink || undefined}>
                {requirementLink || '当前需求缺少 PRD 链接'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {draft && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full"
                onClick={() => setDraftDialogOpen(true)}
              >
                <FileSearch className="h-3.5 w-3.5" />
                查看草稿
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-full"
              disabled={!canEdit || !ready || loading || readingContext || job?.status === 'paused' || jobActive || draft?.status === 'generating'}
              onClick={() => void handleGenerate()}
            >
              {loading || jobActive || draft?.status === 'generating' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {loading || jobActive || draft?.status === 'generating' ? '生成中...' : draft ? '生成新版' : auth?.authorized ? '生成初稿' : '授权并生成初稿'}
            </Button>
          </div>
        </div>
        {monitorRun && <TaskMonitor key={monitorRun.startedAt} run={monitorRun}
          onViewResult={draft?.status === 'draft' ? () => setDraftDialogOpen(true) : undefined}
          onStop={jobActive || job?.status === 'paused' ? () => void handleStop() : undefined} stopping={stopping}
          onPause={jobActive ? () => void handlePauseOrResume() : undefined}
          onResume={job?.status === 'paused' ? () => void handlePauseOrResume() : undefined}
          onRetry={canEdit && ready && !loading ? () => void handleGenerate() : undefined} />}
        {monitorRun ? <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1">补充上下文 · {contextFiles.length} 个文件</summary>
          <div className="mt-2"><UploadDropzone key={detail.recordId} files={contextFiles} onChange={setContextFiles} onBusyChange={setReadingContext} disabled={!canEdit || loading || applying || jobActive || draft?.status === 'generating'} /></div>
        </details> : <div className="mt-4">
          <UploadDropzone key={detail.recordId} files={contextFiles} onChange={setContextFiles} onBusyChange={setReadingContext} disabled={!canEdit || loading || applying || jobActive || draft?.status === 'generating'} />
        </div>}
        {generationError && !monitorRun && <p role="alert" className="mt-2 text-sm text-destructive">{generationError}</p>}
        {config && !ready && (
          <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700">
            <TriangleAlert className="h-3.5 w-3.5" />
            <span>
              当前运行环境缺少：{config.missingKeys.join('、') || '未知配置'}。
              {window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
                ? ' 本地调试需写入 .env.local 并重启服务。'
                : ' 请检查 PolloCloud Worker 环境变量配置。'}
            </span>
          </div>
        )}
      </div>

      <Dialog open={authDialogOpen} onOpenChange={handleAuthDialogOpenChange}>
        <DialogContent className="max-w-md rounded-lg">
          <DialogHeader>
            <DialogTitle className="text-base">飞书文档授权</DialogTitle>
            <DialogDescription>
              授权飞书读取 PRD 后自动生成；无文档权限时不会调用 AI。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">
            {authUrl && (
              <Button
                type="button"
                className="w-full rounded-full"
                onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink className="h-4 w-4" />前往飞书授权
              </Button>
            )}
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />等待授权完成
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}>
        <DialogContent className="grid h-[min(88dvh,840px)] max-h-[calc(100dvh-2rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl bg-card p-0">
          {draft && (
            <>
              <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-base">评审 AI 草稿</DialogTitle>
                </div>
                <DialogDescription>{draft.prd.title || draft.prd.url}</DialogDescription>
              </DialogHeader>

              <div className="min-h-0 overflow-hidden">
                <div className="h-full min-h-0">
                  {draft.status === 'generating' && (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-3 border border-border bg-muted/20 text-sm text-muted-foreground">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      <span>{draft.summary || '正在生成埋点初稿，请稍候'}</span>
                      <span className="text-xs">生成完成后本页面会自动刷新</span>
                    </div>
                  )}
                  {draft.status === 'failed' && (
                    <div className="border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm text-destructive">
                      <div className="font-medium">AI 埋点初稿生成失败</div>
                      <div className="mt-2 whitespace-pre-wrap text-xs">{draft.failureMessage || '请稍后重新生成'}</div>
                    </div>
                  )}
                  {draft.status === 'draft' && <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在加载评审视图…</p>}><AiDraftReview key={draft.id} draft={draft} selectedIds={selectedIds} onSelect={setSelectedIds} selectedParams={selectedParams} onSelectParams={(id: string, names: string[]) => setSelectedParams((previous) => ({ ...previous, [id]: names }))} disabled={applying} /></Suspense>}
                </div>
              </div>

              <DialogFooter className="shrink-0 border-t border-border bg-background px-5 py-3">
                <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <FileCheck2 className="h-4 w-4" />
                  将录入 {selectedIds.size} 个事件 · {countDraftParams(draft.events, selectedIds, selectedParams)} 个参数
                </div>
                <Button type="button" variant="outline" className="rounded-full" disabled={loading || applying || draft.status === 'generating'} onClick={() => void handleGenerate()}>
                  <RefreshCw className="h-4 w-4" />生成新版
                </Button>
                <Button type="button" className="rounded-full" disabled={draft.status !== 'draft' || !selectedIds.size || applying} onClick={() => void handleApply()}>
                  {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {applying ? '录入中...' : '确认并录入需求单'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default AiTrackingDraftPanel;

async function waitForDraftCompletion(
  recordId: string,
  draftId: string,
  actorId?: string,
  actorLarkId?: string,
): Promise<AiTrackingDraft | null> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    try {
      const { draft } = await getAiTrackingDraft(recordId, draftId, actorId, actorLarkId);
      if (!draft || draft.status === 'applied' || draft.status === 'failed') return draft;
    } catch {
      // A transient status-query failure should not turn an in-flight write into a false failure.
    }
  }
  return null;
}
