import { toast } from 'sonner';
import type { WorkflowNotificationResult } from '@shared/api.interface';

export function showCompletionToast(label: string, notification?: WorkflowNotificationResult) {
  if (!notification) {
    toast.success(`${label}已标记完成`);
    return;
  }

  if (!notification.configured) {
    toast.warning(`${label}已标记完成，但机器人通知未配置`);
    return;
  }

  if (notification.deliveryStatus === 'queued') {
    toast.success(`${label}已标记完成，通知已加入后台队列`);
    return;
  }

  if (notification.sentCount > 0 && notification.failedCount === 0 && notification.skippedCount === 0) {
    toast.success(`${label}已标记完成，已通知 ${notification.sentCount} 人`);
    return;
  }

  const issue = [
    ...(notification.errors || []),
    ...(notification.skippedReasons || []),
  ][0];
  if (notification.sentCount > 0) {
    toast.warning(
      `${label}已标记完成，通知部分送达：成功 ${notification.sentCount}/${notification.recipientCount}${issue ? `，${issue}` : ''}`,
    );
    return;
  }

  if (notification.failedCount === 0 && notification.skippedCount > 0) {
    toast.warning(
      `${label}已标记完成，通知未发送${issue ? `：${issue}` : ''}`,
    );
    return;
  }

  if (notification.failedCount > 0) {
    toast.error(
      `${label}已标记完成，但通知发送失败：成功 0/${notification.recipientCount}${issue ? `，${issue}` : ''}`,
    );
    return;
  }

  toast.warning(`${label}已标记完成，通知发送状态待确认`);
}

