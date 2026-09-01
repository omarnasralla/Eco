import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { RATE_LIMITS } from '@eco/shared';
import { configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuditModule } from './modules/audit/audit.module';
import { AuditService } from './modules/audit/audit.service';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { BudgetsModule } from './modules/budgets/budgets.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { CurrencyModule } from './modules/currency/currency.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DebtsModule } from './modules/debts/debts.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { GoalsModule } from './modules/goals/goals.module';
import { HealthModule } from './modules/health/health.module';
import { IncomeModule } from './modules/income/income.module';
import { MailModule } from './modules/mail/mail.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The process refuses to start on an invalid environment — see
      // env.validation.ts for why that is worth the strictness.
      validate: (raw) => configuration(validateEnv(raw)),
      cache: true,
    }),

    ScheduleModule.forRoot(),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.getOrThrow<number>('throttle.ttl') * 1000,
            limit: config.getOrThrow<number>('throttle.limit'),
          },
          // Named buckets referenced by @Throttle on specific routes.
          { name: 'auth', ttl: 60_000, limit: config.getOrThrow<number>('throttle.authLimit') },
          { name: 'ai', ttl: 60_000, limit: RATE_LIMITS.ai.max },
          { name: 'export', ttl: 3_600_000, limit: RATE_LIMITS.export.max },
        ],
      }),
    }),

    PrismaModule,
    RedisModule,
    AuditModule,
    CurrencyModule,
    MailModule,

    AuthModule,
    UsersModule,
    CategoriesModule,
    IncomeModule,
    ExpensesModule,
    DebtsModule,
    GoalsModule,
    BudgetsModule,
    DashboardModule,
    AiModule,
    NotificationsModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [
    // Order matters: authentication runs before authorisation, and rate
    // limiting runs first of all so an unauthenticated flood is cheap to reject.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },

    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    {
      provide: APP_INTERCEPTOR,
      inject: [Reflector, AuditService],
      useFactory: (reflector: Reflector, audit: AuditService) =>
        new AuditInterceptor(reflector, audit),
    },

    {
      provide: APP_FILTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new AllExceptionsFilter(config.get<boolean>('isProduction') ?? false),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
