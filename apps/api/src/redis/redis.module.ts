import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT, RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Redis');
        const client = new Redis(config.getOrThrow<string>('redis.url'), {
          // Fail fast rather than queueing commands forever behind a dead
          // socket; the cache layer treats errors as a miss.
          maxRetriesPerRequest: 3,
          enableOfflineQueue: false,
          retryStrategy: (attempt) => Math.min(attempt * 200, 3_000),
          lazyConnect: false,
        });

        client.on('error', (err) => logger.warn(`Redis error: ${err.message}`));
        client.on('connect', () => logger.log('Redis connection established'));
        return client;
      },
    },
    RedisService,
  ],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule {}
