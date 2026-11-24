import worker from '../../worker';
import { resetFeishuTokenCache } from '../../worker/feishu-token';

describe('query-library gateway errors', () => {
  beforeEach(() => resetFeishuTokenCache());
  afterEach(() => jest.restoreAllMocks());

  it.each(['/api/query-library/events?source=web', '/api/query-library/events/web:event/params'])(
    'returns readable JSON with HTTP 504 for %s', async (path) => {
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token', expire: 7200 }));
        if (url.includes('/records/search')) return new Response('error code: 504', { status: 504 });
        return new Response(JSON.stringify({ code: 0, data: { record: { record_id: 'event', fields: { evt_id: 'example' } } } }));
      });
      const response = await worker.fetch(new Request(`https://example.test${path}`, { headers: { 'x-pollocloud-user-id': 'user-test' } }),
        { FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'secret' });
      expect(response.status).toBe(504);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toEqual({ message: '飞书服务响应超时（HTTP 504），请稍后重试' });
    },
  );
});
