import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Buffer startup logs so configuration errors surface in the right order
    // rather than interleaved with Nest's own boot output.
    bufferLogs: true,
  });

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const isProduction = config.get<boolean>('isProduction') ?? false;
  const port = config.getOrThrow<number>('port');
  const host = config.getOrThrow<string>('host');
  const prefix = config.getOrThrow<string>('globalPrefix');

  app.setGlobalPrefix(prefix);

  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              // The API returns JSON; it never needs to load scripts or frames.
              scriptSrc: ["'none'"],
              frameAncestors: ["'none'"],
              objectSrc: ["'none'"],
            },
          }
        : false, // Swagger UI needs inline assets in development.
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  app.use(cookieParser());

  app.enableCors({
    origin: config.getOrThrow<string[]>('corsOrigins'),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });

  // No global ValidationPipe. Validation is Zod's job here — the same schemas
  // from @eco/shared validate the browser form and the request body, so there
  // is exactly one definition of every rule. Adding class-validator alongside
  // it would mean a second, decorator-driven stack validating nothing (no DTO
  // classes carry those decorators) while implying that it does.
  // Parameter-level pipes such as ParseUUIDPipe are applied per route.

  // Give in-flight requests a chance to finish when Kubernetes sends SIGTERM.
  app.enableShutdownHooks();

  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Eco API')
      .setDescription('Personal finance ecosystem — REST API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'Registration, sign-in, tokens and two-factor')
      .addTag('users', 'Profile, preferences and data export')
      .addTag('income', 'Income sources and receipts')
      .addTag('expenses', 'Expense tracking')
      .addTag('categories', 'Expense categories')
      .addTag('debts', 'Debts and payoff planning')
      .addTag('goals', 'Savings goals')
      .addTag('budgets', 'Monthly budgets and alerts')
      .addTag('dashboard', 'Aggregates and charts')
      .addTag('ai', 'Eco AI: forecasts, patterns, recommendations and chat')
      .addTag('notifications', 'Notifications and preferences')
      .addTag('reports', 'PDF, Excel and CSV exports')
      .addTag('currency', 'Multi-currency support and exchange rates')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(port, host);

  logger.log(`Eco API listening on http://localhost:${port}/${prefix}`);
  if (!isProduction) {
    logger.log(`API documentation at http://localhost:${port}/${prefix}/docs`);
  }
}

void bootstrap();
