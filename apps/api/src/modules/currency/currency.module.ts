import { Global, Module } from '@nestjs/common';
import { CurrencyController } from './currency.controller';
import { CurrencyService } from './currency.service';

// Global: expenses, income, debts and goals all convert to the user's base
// currency, so injecting this everywhere without repeated imports is worth it.
@Global()
@Module({
  controllers: [CurrencyController],
  providers: [CurrencyService],
  exports: [CurrencyService],
})
export class CurrencyModule {}
