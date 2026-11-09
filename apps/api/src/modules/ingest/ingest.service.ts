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
import { formatMoney } from '@eco/shared';
import { fromIsoDate, todayIso } from '../../common/utils/dates';
import { userToday } from '../../common/utils/user-today';
import { Cron } from '@nestjs/schedule';
import { plausiblePair } from '@eco/core';
import { parseTransactionSms } from './sms-parser';
import type { ParsedSms } from './sms-parser';

/** Where a tap lands when its merchant has never been categorised before. */
const FALLBACK_CATEGORY_SLUG = 'miscellaneous';

/** The width of expenses.externalRef. Longer references are stored as a hash. */
const MAX_REFERENCE_LENGTH = 120;

/**
 * How far back a reversal may reach for the charge it cancels.
 *
 * Banks reverse within days. The window is the safety rail: without one, a
 * reversal would eventually match an unrelated charge of the same amount at
 * the same shop months earlier and delete that instead.
 */
const REVERSAL_WINDOW_DAYS = 30;

/**
 * How long a verification code waits for its purchase alert before it is let
 * go. The alert, when there is one, follows within a minute or two.
 */
const CODE_WAIT_MS = 15 * 60_000;

/** A purchase alert later than this is not the one a code was waiting for. */
const CODE_CLAIM_MS = 2 * 3_600_000;

/**
 * How long a reversal waits for the charge it cancels. It arrived 34 minutes
 * early once; a day is generous for that and short enough that a reversal
 * which never matches is still reported while it can be looked into.
 */
const REVERSAL_WAIT_MS = 24 * 3_600_000;

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

    // The user's own date: an Apple Pay tap at 01:30 in Riyadh is today's
    // spending there, though UTC still calls it yesterday.
    const date = input.date ?? (await userToday(this.prisma, userId));
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

    // Most alerts name a card and the card names the account. The one that
    // names neither carries a channel, and the account declares which channel
    // is its own — otherwise it would fall back to the primary account, which
    // is a different bank in a different country.
    const account = parsed.channel
      ? await this.accountForChannel(userId, parsed.channel)
      : await this.accountForCard(userId, parsed.cardLast4);

    // An international-purchase alert states no date, so it is filed on the day
    // it arrived — which is the day it was spent, since the alert is immediate.
    const occurredOn = parsed.date ?? (await userToday(this.prisma, userId));

    // The message text keyed to this user — stable across retries, different
    // for every genuine transaction.
    //
    // An UNDATED message is the exception, and it matters: the
    // international-purchase alert carries no date and no transaction number,
    // so a subscription at an unchanged price produces a byte-identical text
    // every month. Keyed on the text alone, November's charge would be refused
    // as a repeat of October's and silently never recorded — the same class of
    // failure as the format being unparsed in the first place. The arrival date
    // joins the key there, which still collapses a same-day retry (the failure
    // a reference exists to prevent) while letting next month's charge through.
    const reference = createHash('sha256')
      .update(parsed.date ? `${userId}:${text.trim()}` : `${userId}:${text.trim()}:${occurredOn}`)
      .digest('hex');

    if (parsed.kind === 'IGNORE') {
      this.logger.log(
        `capture sms ignored user=${userId} merchant=${parsed.merchant} ` +
          `card=${parsed.cardLast4 ?? 'none'}`,
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

    if (parsed.kind === 'PENDING') {
      return this.holdPurchase(userId, parsed, reference, account, occurredOn);
    }

    if (parsed.kind === 'TRANSFER') {
      return this.recordTransfer(userId, parsed, reference, account, occurredOn);
    }

    if (parsed.kind === 'BALANCE') {
      return this.recordCheckpoint(userId, userCurrency, parsed, reference, account, occurredOn);
    }

    if (parsed.kind === 'REVERSAL') {
      return this.applyReversal(userId, parsed, reference, account, occurredOn);
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
              occurredOn,
            ),
          ),
          date: fromIsoDate(occurredOn),
          // Receipts have no externalRef column, so the key lives here. Ugly,
          // and worth a column of its own the moment a second thing needs one.
          notes: reference,
        },
      });
      this.logger.log(
        `capture sms received user=${userId} currency=${parsed.currency} ` +
          `channel=${parsed.channel ?? 'card'} account=${account?.name ?? 'none'}`,
      );

      // Neo holds a transfer for three days and cancels it if nobody accepts.
      // The receipt is recorded either way — the user said no second message
      // arrives, so this notice is the only record there will be — but money
      // that disappears through inattention is worth interrupting someone for.
      if (parsed.channel === 'neo-request') {
        void this.notifications
          .transferNeedsAccepting(
            userId,
            parsed.merchant,
            parsed.amountMinor,
            parsed.currency,
            account?.name ?? null,
          )
          .catch((e: Error) => this.logger.warn(`Could not notify: ${e.message}`));
      }
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

    // A verification code may be holding this purchase; a reversal may
    // already be waiting to cancel it.
    const held = await this.claimHeld(userId, parsed);

    const result = await this.capture(
      userId,
      userCurrency,
      {
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        merchant: parsed.merchant,
        date: occurredOn,
        // A foreign purchase states its VAT in riyals while the purchase
        // itself is in dollars. Two currencies cannot be added into one
        // amountMinor, so the fee is noted rather than lost — the row stays
        // truthful about what the bank said, and the few riyals are visible
        // instead of silently missing.
        notes: parsed.fee
          ? `Fees/VAT ${formatMoney(parsed.fee.amountMinor, parsed.fee.currency)}`
          : undefined,
        reference,
      },
      account,
    );

    if (held.code) {
      await this.prisma.pendingCapture.update({
        where: { id: held.code.id },
        data: { expenseId: result.expenseId },
      });
    }

    if (held.reversal && !result.duplicate) {
      // The reversal got here first. The charge is recorded and cancelled in
      // the same breath, the way it would have been in the right order — the
      // reversal's key replaces the purchase's, as applyReversal does.
      await this.prisma.expense.update({
        where: { id: result.expenseId },
        data: { deletedAt: new Date(), externalRef: held.reversal.externalRef },
      });
      await this.prisma.pendingCapture.update({
        where: { id: held.reversal.id },
        data: { resolvedAt: new Date(), resolution: 'CANCELLED', expenseId: result.expenseId },
      });
      await this.redis.invalidateUser(userId);
      void this.notifications
        .expenseReversed(userId, parsed.merchant, parsed.amountMinor, parsed.currency)
        .catch((e: Error) => this.logger.warn(`Could not notify: ${e.message}`));
      this.logger.log(
        `reversal applied late user=${userId} expense=${result.expenseId} ` +
          `merchant=${parsed.merchant} amount=${parsed.amountMinor} ${parsed.currency}`,
      );
    }

    return { ...result, kind: parsed.kind };
  }

  /**
   * Hold a verification code until its purchase alert claims it.
   *
   * A code is sent before a payment is attempted, not after it succeeds. When
   * the payment goes through an alert follows; when it fails nothing does —
   * both WHISH MONEY codes with no alert were top-ups that were declined. So a
   * code is never booked on its own: it is held only so that its alert, early
   * or late, is recognised as one payment rather than counted twice.
   */
  private async holdPurchase(
    userId: string,
    parsed: ParsedSms,
    reference: string,
    account: { id: string; name: string; currency: string } | null,
    occurredOn: string,
  ): Promise<IngestResultDto & { kind: string }> {
    const existing = await this.prisma.pendingCapture.findUnique({
      where: { userId_externalRef: { userId, externalRef: reference } },
    });

    if (!existing) {
      // The alert is not always second. One that already landed claims the
      // code on arrival, so the sweep never records it again.
      const alreadyAlerted = await this.prisma.expense.findFirst({
        where: {
          userId,
          deletedAt: null,
          amountMinor: BigInt(parsed.amountMinor),
          currency: parsed.currency,
          createdAt: { gte: new Date(Date.now() - CODE_CLAIM_MS) },
        },
        orderBy: { createdAt: 'desc' },
      });
      const claimed =
        alreadyAlerted && sameMerchant(alreadyAlerted.merchant ?? '', parsed.merchant)
          ? alreadyAlerted
          : null;

      await this.prisma.pendingCapture.create({
        data: {
          userId,
          accountId: account?.id ?? null,
          kind: 'PURCHASE',
          amountMinor: BigInt(parsed.amountMinor),
          currency: parsed.currency,
          merchant: parsed.merchant,
          occurredOn: fromIsoDate(occurredOn),
          externalRef: reference,
          expiresAt: new Date(Date.now() + CODE_WAIT_MS),
          ...(claimed
            ? { resolvedAt: new Date(), resolution: 'MATCHED', expenseId: claimed.id }
            : {}),
        },
      });
      this.logger.log(
        `capture code held user=${userId} merchant=${parsed.merchant} ` +
          `amount=${parsed.amountMinor} ${parsed.currency} ${claimed ? 'claimed=already-alerted' : 'waiting'}`,
      );
    }

    return {
      kind: parsed.kind,
      expenseId: existing?.expenseId ?? '',
      duplicate: existing !== null,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      merchant: parsed.merchant,
      categoryName: '—',
      needsReview: false,
      accountName: account?.name ?? null,
    };
  }

  /**
   * What a purchase alert finds already waiting for it: a code it claims, and
   * a reversal that came before the charge it cancels.
   */
  private async claimHeld(userId: string, parsed: ParsedSms) {
    const now = Date.now();
    const sameMoney = { amountMinor: BigInt(parsed.amountMinor), currency: parsed.currency };

    const waiting = (
      await this.prisma.pendingCapture.findMany({
        where: {
          userId,
          kind: 'PURCHASE',
          resolvedAt: null,
          ...sameMoney,
          createdAt: { gte: new Date(now - CODE_CLAIM_MS) },
        },
        orderBy: { createdAt: 'asc' },
      })
    ).find((code) => sameMerchant(code.merchant, parsed.merchant));
    if (waiting) {
      await this.prisma.pendingCapture.update({
        where: { id: waiting.id },
        data: { resolvedAt: new Date(), resolution: 'MATCHED' },
      });
    }

    const reversal = await this.prisma.pendingCapture.findFirst({
      where: {
        userId,
        kind: 'REVERSAL',
        resolvedAt: null,
        ...sameMoney,
        merchant: { equals: parsed.merchant, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
    });

    return { code: waiting ?? null, reversal };
  }

  /**
   * Settle what is still held once its wait is over.
   *
   * A code nobody claimed is let go: no alert means the payment did not go
   * through. Recording it instead turned two declined WHISH top-ups into
   * spending that never happened. A reversal nobody claimed is reported, as
   * it always was, a day later than before.
   */
  @Cron('* * * * *')
  async settleHeld(): Promise<void> {
    if (!(await this.redis.acquireLock('pending-captures', 120))) return;
    try {
      const due = await this.prisma.pendingCapture.findMany({
        where: { resolvedAt: null, expiresAt: { lte: new Date() } },
        include: {
          user: { select: { currency: true, deletedAt: true } },
          account: { select: { id: true, name: true, currency: true } },
        },
        orderBy: { expiresAt: 'asc' },
        take: 100,
      });

      for (const held of due) {
        try {
          if (held.user.deletedAt) {
            await this.settle(held.id, 'EXPIRED', null);
            continue;
          }

          if (held.kind === 'PURCHASE') {
            await this.settle(held.id, 'EXPIRED', null);
            this.logger.log(
              `capture code expired user=${held.userId} merchant=${held.merchant} ` +
                `reason=no-alert-followed`,
            );
            continue;
          }

          await this.notifications.reversalUnmatched(
            held.userId,
            held.merchant,
            toNumber(held.amountMinor),
            held.currency,
          );
          await this.settle(held.id, 'EXPIRED', null);
          this.logger.warn(
            `reversal unmatched after waiting user=${held.userId} merchant=${held.merchant} ` +
              `amount=${toNumber(held.amountMinor)} ${held.currency}`,
          );
        } catch (error) {
          // One bad row must not hold up the rest; it is retried next minute.
          this.logger.warn(`Could not settle held capture ${held.id}: ${(error as Error).message}`);
        }
      }
    } finally {
      await this.redis.releaseLock('pending-captures');
    }
  }

  private async settle(id: string, resolution: string, expenseId: string | null) {
    await this.prisma.pendingCapture.update({
      where: { id },
      data: { resolvedAt: new Date(), resolution, ...(expenseId ? { expenseId } : {}) },
    });
  }

  /**
   * Cancel the charge a reversal refers to.
   *
   * The bank is not moving money here — it is retracting a charge it already
   * alerted us about, so the honest record is that the expense never happened.
   * It is deleted, not offset by a credit: a cancelled charge and a refund look
   * identical in a monthly total but not in a list of what you bought, and the
   * reversed row was never a purchase.
   *
   * Matched on amount, currency and merchant, newest first, because that is all
   * the reversal gives us — it carries no reference to the charge it undoes.
   * Narrow enough to be safe: two identical amounts at the same merchant inside
   * the window are the same recurring charge, and cancelling the later one is
   * right. Deliberately NOT matched on account, which is inferred from the card
   * rather than stated, and would miss a charge filed before that card was
   * mapped.
   */
  private async applyReversal(
    userId: string,
    parsed: ParsedSms,
    reference: string,
    account: { id: string; name: string; currency: string } | null,
    occurredOn: string,
  ): Promise<IngestResultDto & { kind: string }> {
    // Already applied? The cancelled row claims the reversal's own reference,
    // and (userId, externalRef) is unique, so there is at most one — a message
    // forwarded twice cancels one expense, not two.
    const already = await this.prisma.expense.findFirst({
      where: { userId, externalRef: reference },
      include: { category: { select: { name: true } } },
    });
    if (already) {
      return {
        kind: parsed.kind,
        expenseId: already.id,
        duplicate: true,
        amountMinor: toNumber(already.amountMinor),
        currency: already.currency,
        merchant: already.merchant ?? parsed.merchant,
        categoryName: already.category.name,
        needsReview: false,
        accountName: account?.name ?? null,
      };
    }

    const reversedOn = fromIsoDate(occurredOn);
    // A bank reverses within days. Looking further back would eventually find
    // an unrelated charge of the same amount at the same shop and delete it.
    const earliest = new Date(reversedOn);
    earliest.setUTCDate(earliest.getUTCDate() - REVERSAL_WINDOW_DAYS);

    const match = await this.prisma.expense.findFirst({
      where: {
        userId,
        deletedAt: null,
        amountMinor: BigInt(parsed.amountMinor),
        currency: parsed.currency,
        merchant: { equals: parsed.merchant, mode: 'insensitive' },
        date: { gte: earliest, lte: reversedOn },
      },
      // The latest one, under the same ordering the expenses list uses.
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: { category: { select: { name: true } } },
    });

    if (!match) {
      // Nothing to cancel yet — which does not mean nothing to cancel. The
      // reversal of a Jeeny hold once arrived 34 minutes before the charge it
      // undid, and refusing it left that charge standing for good. So it
      // waits; the charge is cancelled when it arrives, and only a reversal
      // still unmatched a day later is reported, as this one used to be.
      await this.prisma.pendingCapture.upsert({
        where: { userId_externalRef: { userId, externalRef: reference } },
        create: {
          userId,
          accountId: account?.id ?? null,
          kind: 'REVERSAL',
          amountMinor: BigInt(parsed.amountMinor),
          currency: parsed.currency,
          merchant: parsed.merchant,
          occurredOn: fromIsoDate(occurredOn),
          externalRef: reference,
          expiresAt: new Date(Date.now() + REVERSAL_WAIT_MS),
        },
        update: {},
      });
      this.logger.log(
        `reversal held user=${userId} merchant=${parsed.merchant} ` +
          `amount=${parsed.amountMinor} ${parsed.currency} on=${occurredOn} waiting-for-charge`,
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

    await this.prisma.expense.update({
      where: { id: match.id },
      // The reversal's reference replaces the purchase's, which is what makes
      // this idempotent. It also releases the purchase's reference, matching
      // what deleting an expense by hand does.
      data: { deletedAt: new Date(), externalRef: reference },
    });
    await this.redis.invalidateUser(userId);

    void this.notifications
      .expenseReversed(userId, match.merchant ?? parsed.merchant, parsed.amountMinor, parsed.currency)
      .catch((e: Error) => this.logger.warn(`Could not notify: ${e.message}`));

    this.logger.log(
      `reversal applied user=${userId} expense=${match.id} merchant=${parsed.merchant} ` +
        `amount=${parsed.amountMinor} ${parsed.currency}`,
    );

    return {
      kind: parsed.kind,
      expenseId: match.id,
      duplicate: false,
      amountMinor: toNumber(match.amountMinor),
      currency: match.currency,
      merchant: match.merchant ?? parsed.merchant,
      categoryName: match.category.name,
      needsReview: false,
      accountName: account?.name ?? null,
    };
  }

  /**
   * Record money moving between two accounts the user owns.
   *
   * Neither spending nor income — a top up earns nothing and buys nothing —
   * so no expense and no receipt is created. What it does do is leave one
   * balance and arrive in another, which is why ignoring it stopped being
   * right once the wallet became an account of its own: the wallet was
   * spending riyals nobody had given it.
   *
   * The amount stated here is what ARRIVED, in the wallet's own currency, and
   * that is the reason this message records the move rather than the funding
   * bank's alert. The bank states dollars debited and no balance for the
   * wallet; this states the exact riyals the wallet can now spend. The funding
   * side needs no help, because its balance is read from the bank directly.
   */
  private async recordTransfer(
    userId: string,
    parsed: ParsedSms,
    reference: string,
    account: { id: string; name: string; currency: string } | null,
    occurredOn: string,
  ): Promise<IngestResultDto & { kind: string }> {
    const existing = await this.prisma.transfer.findFirst({
      where: { userId, externalRef: reference },
    });
    if (existing) {
      return {
        kind: parsed.kind,
        expenseId: existing.id,
        duplicate: true,
        amountMinor: toNumber(existing.amountMinor),
        currency: existing.currency,
        merchant: parsed.merchant,
        categoryName: '—',
        needsReview: false,
        accountName: account?.name ?? null,
      };
    }

    // The destination is named on the message's first line ("Top Up to
    // urpay") and matched to an account by name. Matched rather than
    // configured because the name IS the identifier the bank uses, and a
    // wallet that has not been set up as an account yet still produces a
    // correct record of money leaving the account that funded it.
    const destination = await this.prisma.financialAccount.findFirst({
      where: {
        userId,
        deletedAt: null,
        name: { equals: parsed.merchant, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });

    if (!destination) {
      this.logger.warn(
        `transfer destination unknown user=${userId} named=${parsed.merchant} — ` +
          `recorded as leaving ${account?.name ?? 'no account'} only`,
      );
    }

    // The funding bank's alert may have got here first and recorded the
    // dollars that left, waiting on this message for the riyals. The two
    // texts land seconds apart and iOS runs one automation at a time, so
    // which of them arrives — or whether both do — is luck; either alone has
    // to be enough, and the second must complete the first rather than move
    // the same money twice.
    if (account && destination) {
      const half = await this.findSentHalf(userId, account.id, destination.id, parsed, occurredOn);
      if (half) {
        const row = await this.prisma.transfer.update({
          where: { id: half.id },
          data: {
            receivedMinor: BigInt(parsed.amountMinor),
            receivedCurrency: parsed.currency,
            note: null,
            // This message's reference from now on, so a retry of it finds
            // the row instead of pairing again. The bank's half needs no key
            // here: its retry stops at its own checkpoint.
            externalRef: reference,
          },
        });
        await this.redis.invalidateUser(userId);
        this.logger.log(
          `transfer completed user=${userId} ${account.name} -> ${destination.name} ` +
            `sent=${toNumber(half.amountMinor)} ${half.currency} ` +
            `received=${parsed.amountMinor} ${parsed.currency} on=${occurredOn}`,
        );
        return {
          kind: parsed.kind,
          expenseId: row.id,
          duplicate: false,
          amountMinor: parsed.amountMinor,
          currency: parsed.currency,
          merchant: destination.name,
          categoryName: '—',
          needsReview: false,
          accountName: account.name,
        };
      }
    }

    const row = await this.prisma.transfer.create({
      data: {
        userId,
        fromAccountId: account?.id ?? null,
        toAccountId: destination?.id ?? null,
        amountMinor: BigInt(parsed.amountMinor),
        currency: parsed.currency,
        // Stated, not derived: this message's amount is the arriving side.
        receivedMinor: BigInt(parsed.amountMinor),
        receivedCurrency: parsed.currency,
        note: destination ? null : `Destination "${parsed.merchant}" is not an account`,
        occurredOn: fromIsoDate(occurredOn),
        externalRef: reference,
      },
    });
    await this.redis.invalidateUser(userId);

    this.logger.log(
      `transfer user=${userId} ${account?.name ?? 'none'} -> ${destination?.name ?? 'unknown'} ` +
        `${parsed.amountMinor} ${parsed.currency} on=${occurredOn}`,
    );

    return {
      kind: parsed.kind,
      expenseId: row.id,
      duplicate: false,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      merchant: destination?.name ?? parsed.merchant,
      categoryName: '—',
      needsReview: false,
      accountName: account?.name ?? null,
    };
  }

  /**
   * Record a stated balance, and the movement it was stated after.
   *
   * No expense is created. The alert comes from the account that funds the
   * wallet, and the wallet's own purchase alerts are already recorded — a
   * top-up booked here as well would count the same money twice, once leaving
   * Beirut and again being spent in Riyadh. The balance is what has no other
   * source, and chained against the next one it is the only thing that says
   * what the transfer cost.
   */
  private async recordCheckpoint(
    userId: string,
    userCurrency: string,
    parsed: ParsedSms,
    reference: string,
    account: { id: string; name: string; currency: string } | null,
    occurredOn: string,
  ): Promise<IngestResultDto & { kind: string }> {
    const stated = parsed.statedBalanceMinor;
    // The pattern cannot match without one, so this is a guard against a
    // future format being routed here by mistake rather than a real case.
    if (stated === undefined) {
      throw new BadRequestException('That message carried no balance. Nothing was recorded.');
    }

    const existing = await this.prisma.balanceCheckpoint.findFirst({
      where: { userId, externalRef: reference },
    });
    if (existing) {
      return {
        kind: parsed.kind,
        expenseId: existing.id,
        duplicate: true,
        amountMinor: toNumber(existing.amountMinor),
        currency: existing.currency,
        merchant: existing.merchant,
        categoryName: '—',
        needsReview: false,
        accountName: account?.name ?? null,
      };
    }

    const row = await this.prisma.balanceCheckpoint.create({
      data: {
        userId,
        accountId: account?.id ?? null,
        cardLast4: parsed.cardLast4 ?? '????',
        currency: parsed.currency,
        amountMinor: BigInt(parsed.amountMinor),
        statedBalanceMinor: BigInt(stated),
        merchant: parsed.merchant,
        occurredOn: fromIsoDate(occurredOn),
        externalRef: reference,
      },
    });

    // Money that left for somewhere outside the accounts being tracked is
    // spent. A top-up is not — it moves between two of the user's own pockets,
    // and the wallet's own alerts already record what it buys — but a counter
    // withdrawal is money gone, and recording only the balance left $2,400
    // leaving an account with nothing in the ledger to show for it.
    //
    // Dated the same day as the alert, which is also why it cannot
    // double-count: the stated balance already includes it, and an anchored
    // balance applies movements only from the day AFTER. So the expense exists
    // for cash flow and category totals without disturbing the balance.
    // Three outcomes, most specific first.
    //
    // An alias says the money landed in a particular account of the user's —
    // cash withdrawn at a named branch — so it is a transfer, and the
    // destination account gets funded. A bare name match says it went to an
    // account that reports its own inflows (urpay texts its top-ups with the
    // exact riyals credited): this alert supplies the half that message
    // cannot — the dollars that left — and pairs with it, whichever arrives
    // first. Anything else left the tracked accounts, and that is spending.
    const destination = await this.accountForAlias(userId, parsed.merchant, account?.id);
    const own = destination
      ? null
      : await this.ownAccountNamed(userId, parsed.merchant, account?.id);
    const internal = destination !== null || own !== null;

    if (own && account) {
      await this.recordSentHalf(userId, account, own, parsed, reference, occurredOn);
    }

    if (destination) {
      await this.prisma.transfer.create({
        data: {
          userId,
          fromAccountId: account?.id ?? null,
          toAccountId: destination.id,
          amountMinor: BigInt(parsed.amountMinor),
          currency: parsed.currency,
          // The alert states what left; what arrives in a cash pocket is the
          // same money, so both sides are the measured figure.
          receivedMinor: BigInt(parsed.amountMinor),
          receivedCurrency: parsed.currency,
          note: `${parsed.merchant} — into ${destination.name}`,
          occurredOn: fromIsoDate(occurredOn),
          externalRef: `${reference}:transfer`,
        },
      });
      this.logger.log(
        `balance transfer user=${userId} ${account?.name ?? 'none'} -> ${destination.name} ` +
          `${parsed.amountMinor} ${parsed.currency} on=${occurredOn}`,
      );
    }

    const spend = internal
      ? null
      : await this.capture(
          userId,
          userCurrency,
          {
            amountMinor: parsed.amountMinor,
            currency: parsed.currency,
            merchant: parsed.merchant,
            date: occurredOn,
            // A different key from the checkpoint's: one message produces two
            // rows and they must not collide on the unique index.
            reference: `${reference}:spend`,
          },
          account,
        );

    await this.redis.invalidateUser(userId);

    this.logger.log(
      `balance checkpoint user=${userId} card=${parsed.cardLast4 ?? 'none'} ` +
        `amount=${parsed.amountMinor} ${parsed.currency} balance=${stated} on=${occurredOn} ` +
        `spent=${destination ? 'no-transfer' : own ? `no-internal to=${own.name}` : 'yes'}`,
    );

    return {
      kind: parsed.kind,
      // The expense when one was created, so the shortcut's reply points at
      // the row the user can actually edit.
      expenseId: spend?.expenseId ?? row.id,
      duplicate: false,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      merchant: parsed.merchant,
      categoryName: spend?.categoryName ?? '—',
      needsReview: spend?.needsReview ?? false,
      accountName: account?.name ?? null,
    };
  }

  /**
   * The account whose alias this merchant matches, if any.
   *
   * An alias is a merchant substring an account's inflows arrive under — a
   * cash account lists the branch names its withdrawals read as. Checked
   * before the name match and before spending, because it is the most
   * specific statement available: the user has said in so many words that
   * money arriving under this string lands here.
   */
  private async accountForAlias(
    userId: string,
    merchant: string,
    exceptAccountId?: string,
  ): Promise<{ id: string; name: string } | null> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, alertAliases: true },
    });
    const haystack = merchant.toLowerCase();
    return (
      accounts.find(
        (a) =>
          a.id !== exceptAccountId &&
          a.alertAliases.some(
            (alias) => alias.trim().length > 0 && haystack.includes(alias.trim().toLowerCase()),
          ),
      ) ?? null
    );
  }

  /**
   * Which of the user's own accounts this merchant names, if any.
   *
   * A bank writes the destination into the merchant field, so a top-up reads
   * "URPAYRIYADH SA" — the wallet's name with a city stuck to it. Matched as a
   * substring for that reason, and only against OTHER accounts: the alert's
   * own account always matches itself and would make every withdrawal look
   * internal.
   *
   * Names under four characters are skipped. "Neo" would match NEON SIGNS and
   * quietly turn a purchase into a transfer — and a transfer mistaken for a
   * purchase is cosmetic, where a purchase mistaken for a transfer is a wrong
   * total.
   */
  private async ownAccountNamed(
    userId: string,
    merchant: string,
    exceptAccountId?: string,
  ): Promise<{ id: string; name: string; currency: string } | null> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true, currency: true },
    });
    const haystack = merchant.toLowerCase();
    return (
      accounts.find(
        (a) =>
          a.id !== exceptAccountId && a.name.length >= 4 && haystack.includes(a.name.toLowerCase()),
      ) ?? null
    );
  }

  /**
   * The funding bank's half of a move into one of the user's own accounts.
   *
   * Completes the transfer the destination's own message already recorded,
   * when there is one: that row knows the riyals and only guessed the
   * dollars, in the riyals' own currency, and this states them. Otherwise it
   * records the move from this side, with the arriving amount left unstated —
   * the destination's balance converts an estimate until its message, if it
   * ever comes, states the real one.
   */
  private async recordSentHalf(
    userId: string,
    from: { id: string; name: string; currency: string },
    to: { id: string; name: string; currency: string },
    parsed: ParsedSms,
    reference: string,
    occurredOn: string,
  ): Promise<void> {
    const candidates = await this.prisma.transfer.findMany({
      where: {
        userId,
        fromAccountId: from.id,
        toAccountId: to.id,
        deletedAt: null,
        receivedMinor: { not: null },
        occurredOn: this.aroundDay(occurredOn),
      },
    });

    let best: { id: string; deviation: number } | null = null;
    for (const t of candidates) {
      // Money leaves an account in that account's currency, so a sent side
      // in any other is the destination's guess — the only kind this may
      // overwrite. One already in the account's currency was stated; it is
      // this move only when nothing changed currency and the amount agrees.
      if (t.currency === from.currency) {
        const deviation = Math.abs(toNumber(t.amountMinor) - parsed.amountMinor);
        const same = t.currency === parsed.currency && deviation <= parsed.amountMinor * 0.05;
        if (same && (!best || deviation < best.deviation)) best = { id: t.id, deviation };
        continue;
      }
      const received = toNumber(t.receivedMinor!);
      const fair = await this.currency.convertForDisplay(
        received,
        t.receivedCurrency!,
        parsed.currency,
        occurredOn,
      );
      const move = {
        sentMinor: parsed.amountMinor,
        sentCurrency: parsed.currency,
        receivedMinor: received,
        receivedCurrency: t.receivedCurrency!,
        fairSentMinor: fair,
      };
      if (!plausiblePair(move)) continue;
      const deviation = Math.abs(parsed.amountMinor - fair);
      if (!best || deviation < best.deviation) best = { id: t.id, deviation };
    }

    if (best) {
      await this.prisma.transfer.update({
        where: { id: best.id },
        data: { amountMinor: BigInt(parsed.amountMinor), currency: parsed.currency },
      });
      this.logger.log(
        `transfer completed user=${userId} ${from.name} -> ${to.name} ` +
          `sent=${parsed.amountMinor} ${parsed.currency} on=${occurredOn}`,
      );
      return;
    }

    await this.prisma.transfer.create({
      data: {
        userId,
        fromAccountId: from.id,
        toAccountId: to.id,
        amountMinor: BigInt(parsed.amountMinor),
        currency: parsed.currency,
        receivedMinor: null,
        receivedCurrency: null,
        note: `${to.name} has not confirmed what arrived yet`,
        occurredOn: fromIsoDate(occurredOn),
        externalRef: `${reference}:transfer`,
      },
    });
    this.logger.log(
      `transfer sent half user=${userId} ${from.name} -> ${to.name} ` +
        `${parsed.amountMinor} ${parsed.currency} on=${occurredOn} awaiting=${to.name}`,
    );
  }

  /**
   * A transfer recorded from the funding side and still waiting on the
   * destination's message, which this one may be. Same accounts, a day either
   * way — the two texts can straddle midnight — and an amount that prices
   * like the same move; the closest wins when a day holds two.
   */
  private async findSentHalf(
    userId: string,
    fromAccountId: string,
    toAccountId: string,
    parsed: ParsedSms,
    occurredOn: string,
  ) {
    const candidates = await this.prisma.transfer.findMany({
      where: {
        userId,
        fromAccountId,
        toAccountId,
        deletedAt: null,
        receivedMinor: null,
        occurredOn: this.aroundDay(occurredOn),
      },
    });

    let best: { row: (typeof candidates)[number]; deviation: number } | null = null;
    for (const t of candidates) {
      const sent = toNumber(t.amountMinor);
      const fair = await this.currency.convertForDisplay(
        parsed.amountMinor,
        parsed.currency,
        t.currency,
        occurredOn,
      );
      const move = {
        sentMinor: sent,
        sentCurrency: t.currency,
        receivedMinor: parsed.amountMinor,
        receivedCurrency: parsed.currency,
        fairSentMinor: fair,
      };
      if (!plausiblePair(move)) continue;
      const deviation = Math.abs(sent - fair);
      if (!best || deviation < best.deviation) best = { row: t, deviation };
    }
    return best?.row ?? null;
  }

  private aroundDay(isoDate: string): { gte: Date; lte: Date } {
    const day = fromIsoDate(isoDate).getTime();
    return { gte: new Date(day - 86_400_000), lte: new Date(day + 86_400_000) };
  }

  /**
   * The account that claims this alert channel.
   *
   * Falls back to the card-less path — the primary account — when nothing
   * claims it, and says so loudly. A wrong account is better than a lost
   * receipt, but only if it is visible: the money is real either way, and
   * silently filing it in Beirut when it arrived in Riyadh is the sort of
   * quiet wrongness this capture path has been bitten by before.
   */
  private async accountForChannel(
    userId: string,
    channel: string,
  ): Promise<{ id: string; name: string; currency: string } | null> {
    const claimed = await this.prisma.financialAccount.findFirst({
      where: { userId, deletedAt: null, alertChannel: channel },
      select: { id: true, name: true, currency: true },
    });
    if (claimed) return claimed;

    this.logger.warn(
      `no account claims alert channel "${channel}" for ${userId} — ` +
        `falling back to the primary account`,
    );
    return this.accountForCard(userId, null);
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

/**
 * Whether two names are the same merchant as two different alerts spell it:
 * "Amazon" on the code, "Amazon s" on the purchase. Compared on letters and
 * digits, by whichever is the shorter prefix — and never on fewer than three,
 * so "A" does not match everything.
 */
function sameMerchant(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  const n = Math.min(x.length, y.length, 6);
  return n >= 3 && x.slice(0, n) === y.slice(0, n);
}
