import type { AiTrackingJob, GenerateAiTrackingDraftRequest, GetAiTrackingDraftResponse } from '@shared/api.interface';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response: Response = await fetch(url, { credentials: 'same-origin', ...init });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || '后台任务请求失败');
  return payload as T;
}
const path = (id: string) => `/api/tracking/ai/jobs/${encodeURIComponent(id)}`;
const runners: Map<string, Promise<void>> = new Map();

/** App-scoped connection: route unmounts only unsubscribe from polling, never abort this request. */
function drive(id: string): void {
  if (runners.has(id)) return;
  const pending: Promise<void> = (async () => {
    try {
      const response: Response = await fetch(`${path(id)}/run`, { method: 'POST', credentials: 'same-origin' });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      while (!(await reader.read()).done) { /* Keep the invocation alive; D1 is the authoritative status. */ }
    } catch { /* A dropped connection is recovered from persisted checkpoints by the dispatcher. */ }
    finally { runners.delete(id); }
  })();
  runners.set(id, pending);
}
export async function startAiBackgroundJob(recordId: string, body: GenerateAiTrackingDraftRequest): Promise<AiTrackingJob> {
  const { job } = await request<{ job: AiTrackingJob }>(`/api/tracking/ai/records/${encodeURIComponent(recordId)}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  drive(job.id);
  return job;
}
export async function getLatestAiJob(recordId: string): Promise<AiTrackingJob | null> {
  const { jobs } = await request<{ jobs: AiTrackingJob[] }>(`/api/tracking/ai/jobs?recordId=${encodeURIComponent(recordId)}`);
  const job = jobs[0] || null;
  if (job && (job.status === 'queued' || job.status === 'running')) drive(job.id);
  return job;
}
export async function getAiJob(id: string): Promise<AiTrackingJob> {
  const { job } = await request<{ job: AiTrackingJob }>(path(id));
  if (job.status === 'queued') drive(id);
  return job;
}
export async function stopAiJob(id: string): Promise<AiTrackingJob> {
  return (await request<{ job: AiTrackingJob }>(`${path(id)}/cancel`, { method: 'POST' })).job;
}
export function getAiJobResult(id: string): Promise<GetAiTrackingDraftResponse> {
  return request<GetAiTrackingDraftResponse>(`${path(id)}/result`);
}

export async function pauseAiJob(id: string): Promise<AiTrackingJob> {
  return (await request<{ job: AiTrackingJob }>(`${path(id)}/pause`, { method: 'POST' })).job;
}
export async function resumeAiJob(id: string): Promise<AiTrackingJob> {
  const { job } = await request<{ job: AiTrackingJob }>(`${path(id)}/resume`, { method: 'POST' });
  if (job.status === 'queued') drive(id);
  return job;
}
