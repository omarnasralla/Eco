import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Cache and ephemeral-state layer.
 *
 * Every key is namespaced by user id so a cache invalidation is a scoped
 * pattern delete rather than a global flush, and so no key can ever be read by
 * the wrong tenant. Cache failures are logged and swallowed: Redis being down
 * should make Eco slower, never broken.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  get raw(): Redis {
    return this.client;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (error) {
      this.logger.warn(`Cache read failed for "${key}": ${(error as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`Cache write failed for "${key}": ${(error as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error) {
      this.logger.warn(`Cache delete failed: ${(error as Error).message}`);
    }
  }

  /**
   * Deletes by pattern using SCAN, never KEYS. KEYS blocks the Redis event
   * loop for the length of the keyspace, which on a single shared instance
   * means blocking every other tenant's requests too.
   */
  async delPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          await this.client.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`Pattern delete failed for "${pattern}": ${(error as Error).message}`);
    }
    return deleted;
  }

  /**
   * Read-through cache. On a miss it computes, stores and returns; on a Redis
   * failure it simply computes, so an outage degrades latency and nothing else.
   */
  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /** Invalidates everything derived from a user's financial data. */
  async invalidateUser(userId: string): Promise<void> {
    await this.delPattern(`eco:${userId}:*`);
    // The authenticated-user record the JWT strategy caches lives outside the
    // `eco:` namespace, and it carries role, deletedAt and tokensValidFrom.
    // Leaving it behind means a demoted admin keeps admin for the rest of the
    // TTL, a revoked session keeps working, and a deleted account still
    // authenticates — so it is cleared here rather than left to each caller to
    // remember, which is how it came to be missed.
    await this.del(`auth:user:${userId}`);
  }

  /** Namespaced key builder — the only sanctioned way to construct a key. */
  key(userId: string, ...parts: (string | number)[]): string {
    return `eco:${userId}:${parts.join(':')}`;
  }

  /**
   * Best-effort distributed lock, so a scheduled job running on three replicas
   * does not send the same user three copies of the same reminder.
   */
  async acquireLock(name: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(`lock:${name}`, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch {
      return false;
    }
  }

  async releaseLock(name: string): Promise<void> {
    await this.del(`lock:${name}`);
  }
}
