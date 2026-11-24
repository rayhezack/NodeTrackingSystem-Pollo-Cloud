type FetchLike = typeof fetch;

export class FeishuRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly upstreamStatus?: number) {
    super(message);
    this.name = 'FeishuRequestError';
  }
}

/** Never try to decode a gateway's plaintext/HTML error page as JSON. */
export async function readFeishuJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const timeout = [408, 504, 524].includes(response.status);
    let detail = '';
    if (!timeout && response.headers.get('content-type')?.includes('application/json')) {
      try {
        const error = await response.json() as { msg?: unknown } | null;
        if (typeof error?.msg === 'string') detail = `：${error.msg}`;
      } catch { /* A malformed error body must not mask the HTTP failure. */ }
    }
    throw new FeishuRequestError(timeout
      ? `飞书服务响应超时（HTTP ${response.status}），请稍后重试`
      : `${operation}: 飞书服务请求失败（HTTP ${response.status}）${detail}，请稍后重试`,
    timeout ? 504 : 502, response.status);
  }
  let payload: { code?: number; msg?: string };
  try {
    payload = await response.json();
  } catch {
    throw new FeishuRequestError(`${operation}: 飞书服务返回了无效的 JSON 响应，请稍后重试`, 502, response.status);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new FeishuRequestError(`${operation}: 飞书服务返回了无效响应，请稍后重试`, 502, response.status);
  }
  if (payload.code !== 0) throw new Error(`${operation}: ${response.status} ${payload.msg || 'unknown error'}`);
  return payload as T;
}

/** Bound the entire read, including response-body decoding. No automatic retries. */
export async function fetchFeishuJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  operation: string,
  options: { allowNotFound: true; timeoutMs?: number },
): Promise<T | null>;
export async function fetchFeishuJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  operation: string,
  options?: { allowNotFound?: false; timeoutMs?: number },
): Promise<T>;
export async function fetchFeishuJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  operation: string,
  options: { allowNotFound?: boolean; timeoutMs?: number } = {},
): Promise<T | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (options.allowNotFound && response.status === 404) return null;
        return readFeishuJson<T>(response, operation);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FeishuRequestError('飞书服务响应超时，请稍后重试', 504));
          controller.abort();
        }, options.timeoutMs ?? 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}
