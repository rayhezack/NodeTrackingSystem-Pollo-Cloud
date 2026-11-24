import axios from 'axios';

export const axiosForBackend = axios.create({
  baseURL: process.env.CLIENT_BASE_PATH || undefined,
  withCredentials: true,
  headers: {
    Accept: 'application/json',
  },
});

// Best-effort immediate dispatch; the durable outbox and cron survive browser closure.
let dispatching: Promise<unknown> | null = null;
axiosForBackend.interceptors.response.use((response) => {
  if (response.headers['x-tracking-storage'] === 'd1' && ['post', 'patch', 'put', 'delete'].includes(response.config.method || '') && !dispatching) {
    dispatching = (async () => {
      for (let batch = 0; batch < 10; batch++) {
        const result = await axiosForBackend.post<{ processed: number }>('/api/data-sync/dispatch');
        if (result.data.processed < 50) break;
      }
    })().catch(() => undefined).finally(() => { dispatching = null; });
  }
  return response;
});
