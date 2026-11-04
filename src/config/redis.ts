/** In-memory stand-in for the Redis client: just the get/set-with-TTL the assistant uses. */
const store = new Map<string, { value: string; expiresAt: number }>();

export const redisConnection = {
  async get(key: string): Promise<string | null> {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return hit.value;
  },
  async set(key: string, value: string, _mode?: 'EX', seconds = 3600): Promise<'OK'> {
    store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  },
};
