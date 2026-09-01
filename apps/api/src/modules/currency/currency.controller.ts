import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CURRENCIES } from '@eco/shared';
import { CurrencyService } from './currency.service';

@ApiTags('currency')
@Controller('currency')
export class CurrencyController {
  constructor(private readonly currency: CurrencyService) {}

  @Get('supported')
  @ApiOperation({ summary: 'List supported currencies with symbols and precision' })
  supported() {
    return { currencies: CURRENCIES };
  }

  @Get('rates')
  @ApiOperation({ summary: 'Exchange rates for a date (defaults to today)' })
  async rates(@Query('date') date?: string) {
    return this.currency.getRates(date);
  }

  @Get('convert')
  @ApiOperation({ summary: 'Convert an amount in minor units between currencies' })
  async convert(
    @Query('amountMinor') amountMinor: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('date') date?: string,
  ) {
    const converted = await this.currency.convert(Number(amountMinor), from, to, date);
    return { amountMinor: converted, currency: to };
  }
}
