import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Validates a request body/query against a Zod schema from @eco/shared.
 *
 * The same schema object validates the form in the browser, so a rule can never
 * drift between client and server: there is only one rule. The pipe returns the
 * *parsed* value, so defaults and coercions (trimming, lowercasing an email)
 * reach the service already applied.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({
          message: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
          error: 'Validation Failed',
          statusCode: 400,
        });
      }
      throw error;
    }
  }
}

/** Convenience factory: `@Body(zodBody(expenseSchema)) dto: ExpenseInput`. */
export const zodBody = <T>(schema: ZodSchema<T>) => new ZodValidationPipe(schema);
