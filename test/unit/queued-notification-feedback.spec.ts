import { webcrypto } from 'node:crypto';
import { toast } from 'sonner';
import { database } from './sqlite-d1.fixture';
import { D1RecordStore, ensureRecordStore } from '../../worker/d1-record-store';
import { sendWorkflowNotification, type WorkflowTransitionNotification } from '../../worker/feishu-notification';
import { showCompletionToast } from '../../client/src/pages/tracking-detail/stage-completion-toast';
import type { WorkflowNotificationResult } from '../../shared/api.interface';

jest.mock('sonner', () => ({ toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() } }));
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const payload: WorkflowTransitionNotification = {
  source: 'web', recordId: 'web:record', requestName: '通知回归',
  fromStage: '埋点验收', toStage: '埋点上线', actionText: '已验收',
  targetStageId: 'launch', priority: 'P1', platform: 'Web', eventIds: ['test_event'], eventNames: ['测试事件'],
  recipients: [
    { user_id: 'owner', email: 'owner@example.com', role: '需求提出人' },
    { user_id: 'owner', email: 'owner@example.com', role: '数据负责人' },
  ],
};
const result: WorkflowNotificationResult = {
  planned: true, configured: true, recipientCount: 2, sentCount: 0, skippedCount: 0, failedCount: 0,
};

describe('completion feedback for asynchronous notifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports a durably queued notification as pending delivery rather than failure or already sent', async () => {
    const DB = database();
    await ensureRecordStore(DB);
    const store = new D1RecordStore(DB);
    const fetchMock = jest.fn().mockRejectedValue(new Error('Unexpected network I/O before commit'));
    const response = await sendWorkflowNotification({ LOCAL_STORE: store, FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test' }, payload, fetchMock);
    await store.commit();
    showCompletionToast('埋点验收', response);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('后台队列'));
    expect(response).toMatchObject({ deliveryStatus: 'queued', recipientCount: 1, sentCount: 0, failedCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await DB.prepare("SELECT status,payload FROM tracking_sync_outbox WHERE instance='__notification'").first<{ status: string; payload: string }>();
    expect(row?.status).toBe('pending');
    expect(JSON.parse(row?.payload || '{}').recipients).toEqual([
      expect.objectContaining({ user_id: 'owner', role: '需求提出人、数据负责人' }),
    ]);
  });

  it('does not invent a failure for an older response with zero deliveries and no reported errors', () => {
    showCompletionToast('埋点验收', result);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('待确认'));
  });

  it.each([
    [{ sentCount: 2 }, 'success'],
    [{ sentCount: 1, failedCount: 1, errors: ['network error'] }, 'warning'],
    [{ failedCount: 2, errors: ['network error'] }, 'error'],
    [{ skippedCount: 2, skippedReasons: ['no recipients'] }, 'warning'],
    [{ configured: false }, 'warning'],
  ] as const)('preserves truthful feedback for resolved delivery result %j', (patch, kind) => {
    showCompletionToast('埋点验收', { ...result, ...patch });
    expect(toast[kind]).toHaveBeenCalledTimes(1);
    if ('errors' in patch) expect(toast[kind]).toHaveBeenCalledWith(expect.stringContaining('network error'));
  });
});
