import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import type { ApiErrorBody } from '@eco/shared';

/**
 * Single exit point for every error leaving the API.
 *
 * Two jobs. First, translate infrastructure errors (Prisma codes) into honest
 * HTTP status codes rather than a blanket 500. Second, make sure an unexpected
 * exception never leaks a stack trace, SQL fragment or column name to the
 * client — in production the caller gets a generic message plus a request id,
 * and the full detail goes to the logs where it belongs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    const { status, message, error } = this.translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
      this.logger.warn(`${request.method} ${request.url} → ${status} [${requestId}]`);
    }

    const body: ApiErrorBody = {
      statusCode: status,
      error,
      message:
        this.isProduction && status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'An unexpected error occurred. Please try again.'
          : message,
      requestId,
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const status = exception.getStatus();
      if (typeof res === 'string') {
        return { status, message: res, error: exception.name };
      }
      const obj = res as { message?: string | string[]; error?: string };
      return {
        status,
        message: obj.message ?? exception.message,
        error: obj.error ?? exception.name,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'The request did not match the expected shape.',
        error: 'Bad Request',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : 'Internal server error',
      error: 'Internal Server Error',
    };
  }

  private translatePrisma(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
    error: string;
  } {
    switch (e.code) {
      case 'P2002': {
        // Unique violation. Name the field, never echo the value — it could be
        // another user's email, and confirming it exists is an enumeration leak.
        const target = (e.meta?.['target'] as string[] | undefined)?.join(', ') ?? 'field';
        return {
          status: HttpStatus.CONFLICT,
          message: `A record with this ${target} already exists.`,
          error: 'Conflict',
        };
      }
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A referenced record does not exist.',
          error: 'Bad Request',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'The requested record was not found.',
          error: 'Not Found',
        };
      case 'P2014':
        return {
          status: HttpStatus.CONFLICT,
          message: 'This record is still referenced by other data and cannot be removed.',
          error: 'Conflict',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'A database error occurred.',
          error: 'Internal Server Error',
        };
    }
  }
}
