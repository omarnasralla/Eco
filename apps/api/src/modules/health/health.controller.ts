import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liveness. Deliberately checks nothing external — if this fails the process
   * is broken and Kubernetes should restart it. Making liveness depend on the
   * database would turn a brief database blip into a cluster-wide restart loop.
   */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * Readiness. Checks the dependencies a request actually needs, so a pod with
   * a broken database connection is pulled from the load balancer rather than
   * serving errors.
   */
  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  ready() {
    return this.health.check([
      () => this.db.pingCheck('database', this.prisma, { timeout: 3_000 }),
      async () => {
        try {
          const pong = await this.redis.raw.ping();
          return { redis: { status: pong === 'PONG' ? 'up' : 'down' } };
        } catch {
          // Redis is a cache, not a dependency: the API degrades to
          // uncached reads rather than failing readiness.
          return { redis: { status: 'up', degraded: true } };
        }
      },
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }
}
