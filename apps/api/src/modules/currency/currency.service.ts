import { Injectable, Logger, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_TTL_SECONDS, CURRENCIES, convertMinor, type ExchangeRateDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/**
 * Multi-currency support.
 *
 * Every rate is stored against a single base (USD) and cross-rates are derived,
 * so we hold N rows a day rather than N². Historical rates are kept because a
 * transaction is converted at the rate on its own date and that figure is then
 * frozen onto the row — restating last year's spending every time the dollar
 * moves would make a user's own reports disagree with each other.
 */
@Injectable()
export class CurrencyService implements OnModuleInit {
  private readonly logger = new Logger(CurrencyService.name);
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.base = config.getOrThrow<string>('fx.baseCurrency');
  }

  /** Rates for a date, falling back to the most recent available. */
  async getRates(date?: string): Promise<ExchangeRateDto> {
    const target = date ?? new Date().toISOString().slice(0, 10);
    const cacheKey = `fx:${this.base}:${target}`;

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS.exchangeRates, async () => {
      // Weekends and holidays have no publication, so take the latest row on
      // or before the requested date rather than returning nothing.
      const latest = await this.prisma.exchangeRate.findFirst({
        where: { base: this.base, date: { lte: new Date(`${target}T00:00:00Z`) } },
        orderBy: { date: 'desc' },
        select: { date: true, provider: true, fetchedAt: true },
      });

      if (!latest) {
        this.logger.warn(`No exchange rates on or before ${target}; falling back to parity`);
        return {
          base: this.base,
          date: target,
          rates: { [this.base]: 1 },
          provider: 'none',
          fetchedAt: new Date().toISOString(),
        } satisfies ExchangeRateDto;
      }

      const rows = await this.prisma.exchangeRate.findMany({
        where: { base: this.base, date: latest.date },
        select: { quote: true, rate: true },
      });

      const rates: Record<string, number> = { [this.base]: 1 };
      for (const row of rows) rates[row.quote] = row.rate.toNumber();

      return {
        base: this.base,
        date: latest.date.toISOString().slice(0, 10),
        rates,
        provider: latest.provider,
        fetchedAt: latest.fetchedAt.toISOString(),
      } satisfies ExchangeRateDto;
    });
  }

  /**
   * A deployment starts with an empty rate table, and the refresh cron does not
   * run until 05:00. Until then every cross-currency conversion would have to
   * fail, so fetch once at boot. Failure is logged and tolerated: the app must
   * still start without a rate provider, and same-currency work is unaffected.
   */
  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.exchangeRate.count({ where: { base: this.base } });
    if (existing > 0) return;

    this.logger.log('No exchange rates stored; fetching an initial set');
    await this.refreshRates();
  }

  /**
   * Converts minor units between currencies at a given date's rate.
   * Same-currency conversion short-circuits — by far the common case, and it
   * must never be perturbed by a rounding step.
   *
   * Throws when a rate is genuinely missing. It is tempting to fall back to the
   * unconverted figure, but that is the worst available answer: 1,000,000 LBP
   * would be written to `baseAmountMinor` as though it were $10,000, and once a
   * wrong number is frozen onto the row every dashboard, budget and report
   * silently inherits it. Refusing the write is recoverable; corrupt history is
   * not.
   */
  async convert(
    amountMinor: number,
    from: string,
    to: string,
    date?: string,
  ): Promise<number> {
    if (from === to) return amountMinor;
    const { rates } = await this.getRates(date);
    try {
      return convertMinor(amountMinor, from, to, rates);
    } catch (error) {
      // Returning the amount unconverted here would file 375 riyals as 375
      // dollars — a silent 4x error in the user's own ledger, indistinguishable
      // afterwards from a real figure. A refused write is recoverable; a wrong
      // number that looks right is not. Entries in the base currency never
      // reach this path, so an outage cannot stop ordinary use.
      this.logger.error(`Conversion ${from}→${to} failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        `No exchange rate is available for ${from} to ${to} right now. ` +
          `Try again shortly, or enter the amount in ${to}.`,
      );
    }
  }

  /**
   * Lenient conversion for read-only aggregates, where one unconvertible stream
   * should not take down the whole summary. Nothing computed here is persisted,
   * so a slightly wrong total is preferable to an error page.
   */
  async convertForDisplay(
    amountMinor: number,
    from: string,
    to: string,
    date?: string,
  ): Promise<number> {
    if (from === to) return amountMinor;
    const { rates } = await this.getRates(date);
    try {
      return convertMinor(amountMinor, from, to, rates);
    } catch (error) {
      this.logger.warn(
        `Display conversion ${from}→${to} failed (${(error as Error).message}); using face value`,
      );
      return amountMinor;
    }
  }

  /** Refreshes rates nightly from the configured provider. */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async refreshRates(): Promise<void> {
    // Several replicas run this cron; only one should do the work.
    if (!(await this.redis.acquireLock('fx-refresh', 300))) return;

    try {
      const provider = this.config.getOrThrow<string>('fx.provider');
      const rates = await this.fetchFromProvider(provider);
      if (!rates) return;

      const date = new Date(new Date().toISOString().slice(0, 10));
      await this.prisma.$transaction(
        Object.entries(rates).map(([quote, rate]) =>
          this.prisma.exchangeRate.upsert({
            where: { base_quote_date: { base: this.base, quote, date } },
            create: { base: this.base, quote, rate, date, provider },
            update: { rate, fetchedAt: new Date() },
          }),
        ),
      );

      await this.redis.delPattern('fx:*');
      this.logger.log(`Refreshed ${Object.keys(rates).length} exchange rates from ${provider}`);

      // A provider that silently omits a currency we offer is the failure that
      // is hardest to notice: everything looks healthy until someone records an
      // expense in it. Name the gap at refresh time, not at write time.
      const uncovered = CURRENCIES.map((c) => c.code).filter(
        (code) => code !== this.base && rates[code] === undefined,
      );
      if (uncovered.length > 0) {
        this.logger.warn(
          `Provider "${provider}" quotes no rate for ${uncovered.join(', ')} — ` +
            `amounts in those currencies will be rejected rather than mis-converted.`,
        );
      }
    } catch (error) {
      // Stale rates are far better than a crashed scheduler; yesterday's rate
      // moves a converted total by fractions of a percent.
      this.logger.error(`Exchange-rate refresh failed: ${(error as Error).message}`);
    } finally {
      await this.redis.releaseLock('fx-refresh');
    }
  }

  private async fetchFromProvider(provider: string): Promise<Record<string, number> | null> {
    if (provider === 'openexchangerates') {
      const appId = this.config.get<string>('fx.appId');
      if (!appId) {
        this.logger.warn('OPENEXCHANGERATES_APP_ID is not set; skipping refresh');
        return null;
      }
      const res = await fetch(
        `https://openexchangerates.org/api/latest.json?app_id=${appId}&base=${this.base}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) throw new Error(`Provider returned ${res.status}`);
      const body = (await res.json()) as { rates: Record<string, number> };
      return body.rates;
    }

    if (provider === 'erapi') {
      // exchangerate-api's open endpoint: free, no key, and — unlike the ECB —
      // it quotes all 160-odd ISO codes, including the pegged and managed
      // currencies (LBP, SAR, AED, EGP, JOD, KWD, NGN) that our own supported
      // list contains. This is the default for that reason.
      const res = await fetch(`https://open.er-api.com/v6/latest/${this.base}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Provider returned ${res.status}`);
      const body = (await res.json()) as { result?: string; rates: Record<string, number> };
      if (body.result && body.result !== 'success') {
        throw new Error(`Provider reported "${body.result}"`);
      }
      return body.rates;
    }

    if (provider === 'ecb') {
      // Frankfurter wraps the ECB reference rates: free, no key, daily. Note
      // the ECB publishes only ~30 majors — see the coverage check in
      // refreshRates for what that leaves unquoted.
      const res = await fetch(`https://api.frankfurter.app/latest?base=${this.base}`, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`Provider returned ${res.status}`);
      const body = (await res.json()) as { rates: Record<string, number> };
      return body.rates;
    }

    // 'fixed' — offline development, so conversion is exercised without a
    // network. Every supported currency appears; a gap here would send the
    // dev-mode write path down the throwing branch of convert().
    return {
      EUR: 0.92, GBP: 0.79, AED: 3.6725, SAR: 3.75, EGP: 48.5, LBP: 89500,
      JOD: 0.709, KWD: 0.307, CAD: 1.36, AUD: 1.51, CHF: 0.88, JPY: 147,
      INR: 84.2, TRY: 34.5, NGN: 1580, ZAR: 18.1,
    };
  }
}
