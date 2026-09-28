import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  CreatedIngestTokenDto,
  IngestExpenseInput,
  IngestResultDto,
  IngestTokenDto,
} from '@eco/shared';
import { DEFAULT_CATEGORIES } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { NotificationsService } from '../notifications/notifications.service';
import { detectCurrency, parseAmountToMinor } from '../../common/utils/parse-amount';
import { toNumber } from '../../common/utils/money';
import { fromIsoDate, todayIso } from '../../common/utils/dates';
import { parseTransactionSms } from './sms-parser';

/** Where a tap lands when its merchant has never been categorised before. */
const FALLBACK_CATEGORY_SLUG = 'miscellaneous';

/** The width of expenses.externalRef. Longer references are stored as a hash. */
const MAX_REFERENCE_LENGTH = 120;

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Tokens ───────────────────────────────────────────────────────────────

  async listTokens(userId: string): Promise<IngestTokenDto[]> {
    const tokens = await this.prisma.ingestToken.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map(toTokenDto);
  }

  /**
   * Mint a token. The secret is returned here and never again.
   *
   * 32 random bytes, base64url: the entropy is what protects an endpoint that
   * has no second factor and no expiry behind it.
   */
  async createToken(userId: string, label: string): Promise<CreatedIngestTokenDto> {
    const secret = randomBytes(32).toString('base64url');
    const token = `eco_${userId.replace(/-/g, '')}_${secret}`;

    const row = await this.prisma.ingestToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        label,
      },
    });
    return { ...toTokenDto(row), token };
  }

  /**
   * Revoked, not deleted. The rows it created stay explicable, and a token
   * that was once used is a thing that happened.
   */
  async revokeToken(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.ingestToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Token not found');
  }

  // ── Capture ──────────────────────────────────────────────────────────────

  /**
   * Record a tap.
   *
   * The phone knows three things — how much, where, and which card — and none
   * of them is a category. So the category is inferred from what this user
   * chose the last time they spent at this merchant, and marked `needsReview`
   * when there is nothing to infer from. The row is otherwise an ordinary
   * expense: it counts in balances, budgets and every total, because the money
   * is gone whether or not anyone has confirmed which box it belongs in.
   */
  async capture(
    userId: string,
    userCurrency: string,
    input: IngestExpenseInput,
    /**
     * The account, when the caller has already identified it. A bank alert
     * names the card, which maps to an account exactly; guessing again from
     * the card's display name would be strictly worse.
     */
    resolvedAccount?: { id: string; name: string; currency: string } | null,
  ): Promise<IngestResultDto> {
    const account = resolvedAccount ?? (await this.matchAccount(userId, input.card));
    // Currency, most trustworthy source first. The middle one matters: the
    // phone sends the amount as it was displayed ("SAR 3.00"), and that text is
    // the only place a foreign currency is named. Defaulting straight to the
    // account would record a 3 SAR coffee as $3.00 on a dollar account —
    // roughly four times the real figure, on a row that looks perfectly normal.
    const detected = typeof input.amount === 'string' ? detectCurrency(input.amount) : null;
    const currency = input.currency ?? detected ?? account?.currency ?? userCurrency;
    // Which of the four sources won. "account" or "user" on a foreign purchase
    // is the signal that the phone sent a bare number and the amount is being
    // read in the wrong currency.
    const currencySource = input.currency
      ? 'body'
      : detected
        ? 'amount-text'
        : account
          ? 'account'
          : 'user-base';
    const amountMinor =
      input.amountMinor ?? parseAmountToMinor(input.amount as string | number, currency);

    const date = input.date ?? todayIso();
    const merchant = input.merchant.trim();
    const { categoryId, categoryName, inferred } = await this.categoryFor(userId, merchant);

    const baseAmountMinor = await this.currency.convert(
      amountMinor,
      currency,
      userCurrency,
      date,
    );

    const data = {
      userId,
      categoryId,
      accountId: account?.id ?? null,
      amountMinor: BigInt(amountMinor),
      currency,
      baseAmountMinor: BigInt(baseAmountMinor),
      date: fromIsoDate(date),
      merchant,
      notes: input.notes?.trim() || null,
      needsReview: !inferred,
      externalRef: normaliseReference(input.reference),
    };

    // Every capture says what it did. The HTTP log records only "201", which
    // was indistinguishable between "expense recorded" and "silently discarded
    // as a duplicate of a row the user had deleted" — the failure that lost a
    // real purchase without a trace.
    //
    // Values are deliberately absent. Request bodies are never logged in this
    // API (they carry salaries and merchant names); the body already belongs in
    // the audit log, which is access-controlled and redacted. What is here is
    // the shape of the decision, which is what makes a silent loss visible.
    const trace = (outcome: string, extra = '') =>
      this.logger.log(
        `capture ${outcome} user=${userId} currency=${currency} ` +
          `currencySource=${currencySource} account=${account ? 'matched' : 'none'} ` +
          `category=${inferred ? 'inferred' : 'fallback'} ref=${data.externalRef ? 'yes' : 'none'}` +
          (extra ? ` ${extra}` : ''),
      );

    try {
      const expense = await this.prisma.expense.create({ data });
      await this.redis.invalidateUser(userId);
      trace('created');
      return {
        expenseId: expense.id,
        duplicate: false,
        amountMinor: toNumber(expense.amountMinor),
        currency: expense.currency,
        merchant,
        categoryName,
        needsReview: expense.needsReview,
        accountName: account?.name ?? null,
      };
    } catch (error) {
      // The same tap, sent twice. A retry from a phone that never saw the first
      // response is the expected case, not an error — so this answers with the
      // row that already exists rather than refusing, which would leave the
      // shortcut showing a failure for an expense that was recorded correctly.
      const existing =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
          ? await this.prisma.expense.findFirst({
              where: { userId, externalRef: data.externalRef, deletedAt: null },
              include: { category: { select: { name: true } }, account: { select: { name: true } } },
            })
          : null;
      if (!existing) throw error;

      // A retry carries the same purchase. Different money under the same
      // reference is not a retry — it is a shortcut sending a fixed reference
      // for every tap, and treating that as a duplicate silently discards real
      // spending while answering "201 created". Refusing is the only way the
      // misconfiguration is ever visible: it costs one rejected expense and
      // saves every one after it.
      const samePurchase =
        toNumber(existing.amountMinor) === amountMinor &&
        existing.currency === currency &&
        (existing.merchant ?? '').toLowerCase() === merchant.toLowerCase() &&
        existing.date.getTime() === fromIsoDate(date).getTime();
      if (!samePurchase) {
        trace('rejected', 'reason=reference-reused-for-different-purchase');
        void this.notifications
          .captureFailed(
            userId,
            'A purchase was rejected as a duplicate',
            'Your shortcut is sending the same reference for every transaction.',
          )
          .catch((e: Error) => this.logger.warn(`Could not notify: ${e.message}`));
        throw new ConflictException(
          `Reference "${data.externalRef}" was already used for a different purchase ` +
            `(${existing.merchant ?? 'unknown'}). Your shortcut is sending the same reference ` +
            `every time — make it unique per tap, for example by including the time to the second.`,
        );
      }

      trace('duplicate', 'reason=same-purchase-resent');
      return {
        expenseId: existing.id,
        duplicate: true,
        amountMinor: toNumber(existing.amountMinor),
        currency: existing.currency,
        merchant: existing.merchant ?? merchant,
        categoryName: existing.category.name,
        needsReview: existing.needsReview,
        accountName: existing.account?.name ?? null,
      };
    }
  }

  /**
   * Record a bank's SMS alert.
   *
   * The phone forwards the message unchanged; everything is read here. That is
   * the point of the design — an alert covers online and in-app purchases the
   * Wallet tap trigger cannot see, and the parsing sits where it can be tested
   * against real messages rather than in a text action on a phone.
   *
   * The message itself is the idempotency key. Two purchases differ by at
   * least their timestamp, so the same text arriving twice is the same event
   * and is answered with the row already recorded.
   */
  async captureSms(
    userId: string,
    userCurrency: string,
    text: string,
  ): Promise<IngestResultDto & { kind: string }> {
    const parsed = parseTransactionSms(text);
    if (!parsed) {
      // Notified before throwing. The phone shows nothing when a shortcut gets
      // a 400, so without this the message is lost in silence — which is
      // exactly how a real purchase went missing for two days.
      void this.notifications
        .captureUnknownFormat(userId, text)
        .catch((e: Error) => this.logger.warn(`Could not notify: ${e.message}`));

      // Refused, never half-read. A message shape nobody has seen might be a
      // refund, a decline, or an advert; guessing at the amount inside it is
      // how money moves in the wrong direction.
      throw new BadRequestException(
        'That message was not recognised as a transaction. Nothing was recorded.',
      );
    }

    // The message text keyed to this user — stable across retries, different
    // for every genuine transaction.
    const reference = createHash('sha256')
      .update(`${userId}:${text.trim()}`)
      .digest('hex');

    const account = await this.accountForCard(userId, parsed.cardLast4);

    if (parsed.kind === 'IGNORE') {
      this.logger.log(
        `capture sms ignored user=${userId} reason=internal-transfer card=${parsed.cardLast4 ?? 'none'}`,
      );
      return {
        kind: parsed.kind,
        expenseId: '',
        duplicate: false,
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        merchant: parsed.merchant,
        categoryName: '—',
        needsReview: false,
        accountName: account?.name ?? null,
      };
    }

    if (parsed.kind === 'RECEIVE') {
      const existing = await this.prisma.incomeReceipt.findFirst({
        where: { userId, notes: reference },
      });
      if (existing) {
        return {
          kind: parsed.kind,
          expenseId: existing.id,
          duplicate: true,
          amountMinor: toNumber(existing.amountMinor),
          currency: existing.currency,
          merchant: existing.name ?? parsed.merchant,
          categoryName: '—',
          needsReview: false,
          accountName: account?.name ?? null,
        };
      }

      const receipt = await this.prisma.incomeReceipt.create({
        data: {
          userId,
          incomeSourceId: null,
          name: parsed.merchant,
          accountId: account?.id ?? null,
          amountMinor: BigInt(parsed.amountMinor),
          currency: parsed.currency,
          baseAmountMinor: BigInt(
            await this.currency.convert(
              parsed.amountMinor,
              parsed.currency,
              userCurrency,
              parsed.date,
            ),
          ),
          date: fromIsoDate(parsed.date),
          // Receipts have no externalRef column, so the key lives here. Ugly,
          // and worth a column of its own the moment a second thing needs one.
          notes: reference,
        },
      });
      this.logger.log(`capture sms received user=${userId} currency=${parsed.currency}`);
      return {
        kind: parsed.kind,
        expenseId: receipt.id,
        duplicate: false,
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        merchant: parsed.merchant,
        categoryName: '—',
        needsReview: false,
        accountName: account?.name ?? null,
      };
    }

    const result = await this.capture(
      userId,
      userCurrency,
      {
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        merchant: parsed.merchant,
        date: parsed.date,
        reference,
      },
      account,
    );
    return { ...result, kind: parsed.kind };
  }

  /** The account holding this card, or the primary one when the card is unknown. */
  private async accountForCard(
    userId: string,
    cardLast4: string | null,
  ): Promise<{ id: string; name: string; currency: string } | null> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, currency: true, isPrimary: true, cardsLast4: true },
    });
    if (accounts.length === 0) return null;

    if (cardLast4) {
      const owning = accounts.filter((a) => a.cardsLast4.includes(cardLast4));
      // Exactly one, or none. Two accounts claiming the same card is a
      // configuration mistake, and picking one at random would file the
      // spending against the wrong balance silently.
      if (owning.length === 1) return owning[0]!;
      if (owning.length > 1) {
        this.logger.warn(`card ${cardLast4} claimed by ${owning.length} accounts for ${userId}`);
      }
    }
    return accounts.find((a) => a.isPrimary) ?? null;
  }

  /**
   * The category this user last used for this merchant.
   *
   * Their own history, not a shared guess: "Cedars" is groceries for one person
   * and dining out for another, and only their past choices know which. Matched
   * case-insensitively because a card terminal's spelling is not stable.
   *
   * Rows previously captured and never reviewed are not evidence — inferring
   * from an unconfirmed inference is how one wrong guess becomes a hundred.
   */
  private async categoryFor(
    userId: string,
    merchant: string,
  ): Promise<{ categoryId: string; categoryName: string; inferred: boolean }> {
    const previous = await this.prisma.expense.findFirst({
      where: {
        userId,
        deletedAt: null,
        needsReview: false,
        merchant: { equals: merchant, mode: 'insensitive' },
      },
      orderBy: { date: 'desc' },
      select: { category: { select: { id: true, name: true } } },
    });
    if (previous) {
      return {
        categoryId: previous.category.id,
        categoryName: previous.category.name,
        inferred: true,
      };
    }

    const related = await this.categoryForRelatedMerchant(userId, merchant);
    if (related) return related;

    const fallback = await this.fallbackCategory(userId);
    return { categoryId: fallback.id, categoryName: fallback.name, inferred: false };
  }

  /**
   * The category of a merchant that is recognisably the same shop.
   *
   * Card terminals qualify names: "Nwateh" is entered by hand, then a tap
   * arrives as "Nwateh Est" and matches nothing. This treats one name as the
   * same shop as another when one is a prefix of the other **and the next
   * character is a boundary** — a space, bracket or dash.
   *
   * That boundary is the whole safeguard. A bare substring test would file
   * "Afternoon Cafe" under whatever "Noon" is, because "noon" appears inside
   * it; requiring "noon " or "noon(" at the start does not match "afternoon"
   * at all. Names shorter than four characters are ignored outright, since a
   * three-letter prefix is a coincidence waiting to happen.
   *
   * The longest match wins, so "Keeta (Subway)" beats "Keeta" when both fit,
   * and the most recent breaks a tie.
   */
  private async categoryForRelatedMerchant(
    userId: string,
    merchant: string,
  ): Promise<{ categoryId: string; categoryName: string; inferred: boolean } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ categoryId: string; name: string }>>`
      SELECT e."categoryId" AS "categoryId", c.name AS name
      FROM expenses e
      JOIN categories c ON c.id = e."categoryId"
      WHERE e."userId" = ${userId}::uuid
        AND e."deletedAt" IS NULL
        AND e."needsReview" = false
        AND e.merchant IS NOT NULL
        AND length(trim(e.merchant)) >= 4
        AND (
          lower(${merchant}) LIKE lower(trim(e.merchant)) || ' %'
          OR lower(${merchant}) LIKE lower(trim(e.merchant)) || '(%'
          OR lower(${merchant}) LIKE lower(trim(e.merchant)) || '-%'
          OR lower(trim(e.merchant)) LIKE lower(${merchant}) || ' %'
          OR lower(trim(e.merchant)) LIKE lower(${merchant}) || '(%'
          OR lower(trim(e.merchant)) LIKE lower(${merchant}) || '-%'
        )
      ORDER BY length(trim(e.merchant)) DESC, e.date DESC
      LIMIT 1
    `;
    const match = rows[0];
    if (!match) return null;
    return { categoryId: match.categoryId, categoryName: match.name, inferred: true };
  }

  /** Miscellaneous, which every account is seeded with — recreated if archived away. */
  private async fallbackCategory(userId: string): Promise<{ id: string; name: string }> {
    const existing = await this.prisma.category.findFirst({
      where: { userId, slug: FALLBACK_CATEGORY_SLUG, deletedAt: null },
      select: { id: true, name: true },
    });
    if (existing) return existing;

    const seed = DEFAULT_CATEGORIES.find((c) => c.slug === FALLBACK_CATEGORY_SLUG)!;
    this.logger.warn(`Recreating missing ${FALLBACK_CATEGORY_SLUG} category for user ${userId}`);
    return this.prisma.category.create({
      data: {
        userId,
        slug: seed.slug,
        name: seed.name,
        icon: seed.icon,
        color: seed.color,
        isSystem: true,
      },
      select: { id: true, name: true },
    });
  }

  /**
   * The account a Wallet card maps to.
   *
   * Wallet card names ("Visa (•••• 4321)") rarely equal an Eco account name, so
   * this matches either way round — the card contains the account's name, or
   * the account's name contains the card's. Failing that it falls back to the
   * primary account, which is right far more often than filing the spend
   * against no account at all and letting a balance silently stop matching.
   */
  private async matchAccount(
    userId: string,
    card: string | null | undefined,
  ): Promise<{ id: string; name: string; currency: string } | null> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, currency: true, isPrimary: true },
    });
    if (accounts.length === 0) return null;

    const needle = card?.trim().toLowerCase();
    if (needle) {
      const match =
        accounts.find((a) => a.name.toLowerCase() === needle) ??
        accounts.find((a) => needle.includes(a.name.toLowerCase())) ??
        accounts.find((a) => a.name.toLowerCase().includes(needle));
      if (match) return match;
    }
    return accounts.find((a) => a.isPrimary) ?? null;
  }
}

/**
 * An idempotency key that fits the column, whatever the phone sent.
 *
 * The obvious reference to build in a shortcut is merchant + amount + time,
 * and a long merchant name takes that past the stored width. Truncating would
 * be wrong — the timestamp is at the end, so two different taps at the same
 * shop would truncate to the same key and the second would be refused as a
 * duplicate. Hashing keeps the whole value's uniqueness in a fixed 64 chars.
 */
function normaliseReference(reference: string | null | undefined): string | null {
  const trimmed = reference?.trim();
  if (!trimmed) return null;
  return trimmed.length <= MAX_REFERENCE_LENGTH
    ? trimmed
    : createHash('sha256').update(trimmed).digest('hex');
}

function toTokenDto(row: {
  id: string;
  label: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}): IngestTokenDto {
  return {
    id: row.id,
    label: row.label,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
