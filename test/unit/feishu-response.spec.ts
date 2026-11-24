import { fetchFeishuJson, readFeishuJson } from '../../worker/feishu-response';
import { getBitableRecord, resetFeishuTokenCache, searchBitableRecordPage, updateBitableRecords } from '../../worker/feishu-bitable';

const credentials = { FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'secret' };
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('Feishu gateway responses', () => {
  beforeEach(() => resetFeishuTokenCache());
  afterEach(() => jest.useRealTimers());

  it.each([504, 524, 502])('does not JSON-decode a plaintext HTTP %s gateway error', async (status) => {
    const response = new Response(`error code: ${status}`, { status });
    const decode = jest.spyOn(response, 'json');
    await expect(readFeishuJson(response, 'read failed')).rejects.toMatchObject({
      name: 'FeishuRequestError', status: status === 502 ? 502 : 504, upstreamStatus: status,
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['not-json', 'null', '[]'])('reports an invalid successful payload safely: %s', async (body) => {
    await expect(readFeishuJson(new Response(body), 'read failed')).rejects.toMatchObject({
      name: 'FeishuRequestError', status: 502,
    });
  });

  it('preserves Feishu API errors in an otherwise successful HTTP response', async () => {
    await expect(readFeishuJson(jsonResponse({ code: 123, msg: 'invalid field' }), 'search failed'))
      .rejects.toThrow('search failed: 200 invalid field');
  });

  it('preserves structured non-timeout HTTP error details without exposing raw error pages', async () => {
    const response = new Response(JSON.stringify({ code: 403, msg: 'permission denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    await expect(readFeishuJson(response, 'read failed')).rejects.toThrow('permission denied');
  });

  it.each(['headers', 'body'])('bounds a hanging response while waiting for %s', async (phase) => {
    jest.useFakeTimers();
    const response = new Response();
    jest.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const transport = jest.fn().mockImplementation(() => phase === 'body' ? Promise.resolve(response) : new Promise(() => {}));
    const pending = fetchFeishuJson(transport, 'https://example.test', {}, 'search failed', { timeoutMs: 50 });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'FeishuRequestError', status: 504 });
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('handles plaintext timeouts from token acquisition as well as parameter reads', async () => {
    const tokenFailure = jest.fn().mockResolvedValue(new Response('error code: 504', { status: 504 }));
    await expect(searchBitableRecordPage(credentials, 'officialParamDetail', {}, tokenFailure)).rejects.toMatchObject({ status: 504 });
    const searchFailure = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response('error code: 504', { status: 504 }));
    await expect(searchBitableRecordPage(credentials, 'officialParamDetail', {}, searchFailure)).rejects.toMatchObject({ status: 504 });
    expect(searchFailure).toHaveBeenCalledTimes(2);
  });

  it('preserves a missing-record response without trying to parse its body', async () => {
    const transport = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    await expect(getBitableRecord(credentials, 'queryLibrary', 'missing', transport)).resolves.toBeNull();
  });

  it('does not replay a write after a gateway timeout and preserves uncertain-write tracking', async () => {
    const state = { pending: 0, uncertain: 0 };
    const transport = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response('error code: 504', { status: 504 }));
    await expect(updateBitableRecords({ ...credentials, BASE_WRITE_STATE: state }, 'workbench', [{ id: 'record', record: { evt_id: 'example' } }], transport))
      .rejects.toMatchObject({ status: 504 });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(state).toEqual({ pending: 0, uncertain: 1 });
  });
});
