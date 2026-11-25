import { axiosForBackend } from './http';
import { toReadableError } from './error';
import type {
  OfficialTrackingContextResponse,
  RequestTrackingContextResponse,
  TrackingSource,
} from '@shared/api.interface';

export async function getOfficialTrackingContext(
  source: TrackingSource,
  recordId: string,
): Promise<OfficialTrackingContextResponse> {
  try {
    return (
      await axiosForBackend.get<OfficialTrackingContextResponse>(
        '/api/context/get_event_context',
        { params: { source, recordId } },
      )
    ).data;
  } catch (error) {
    throw toReadableError(error, '正式上下文读取失败');
  }
}
export async function getRequestTrackingContext(
  source: TrackingSource,
  recordId: string,
): Promise<RequestTrackingContextResponse> {
  try {
    return (
      await axiosForBackend.get<RequestTrackingContextResponse>(
        '/api/context/get_request_context',
        { params: { source, recordId } },
      )
    ).data;
  } catch (error) {
    throw toReadableError(error, '需求上下文读取失败');
  }
}
