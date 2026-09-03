import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * Transactional email.
 *
 * Delivery failures are logged, never thrown: a user who cannot receive a
 * "budget exceeded" notice should still get a working API response. The one
 * exception is email verification, where the caller decides how to react.
 *
 * In development this points at MailHog (http://localhost:8025) so nothing
 * real is ever sent while testing.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly webOrigin: string;

  constructor(private readonly config: ConfigService) {
    this.from = config.getOrThrow<string>('mail.from');
    this.webOrigin = config.getOrThrow<string>('webOrigin');

    const user = config.get<string>('mail.user');
    const pass = config.get<string>('mail.password');

    this.transporter = nodemailer.createTransport({
      host: config.getOrThrow<string>('mail.host'),
      port: config.getOrThrow<number>('mail.port'),
      secure: config.getOrThrow<boolean>('mail.secure'),
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
  }

  /**
   * Returns whether delivery was accepted by the transport. Failures are still
   * swallowed rather than thrown — a user who cannot receive a notice should
   * still get a working API response — but a caller that needs to *tell* them
   * the email did not go out can now ask.
   */
  private async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, html, text });
      this.logger.debug(`Sent "${subject}" to ${to}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send "${subject}" to ${to}: ${(error as Error).message}`);
      return false;
    }
  }

  private layout(heading: string, body: string, cta?: { label: string; url: string }): string {
    // Inline styles and a table-free single column: the combination that
    // survives Outlook, Gmail's clipper and dark-mode inversion alike.
    return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">
    <div style="font-size:20px;font-weight:700;color:#16a34a;margin-bottom:24px">Eco</div>
    <h1 style="font-size:20px;margin:0 0 16px;font-weight:600">${heading}</h1>
    <div style="font-size:15px;line-height:1.6;color:#334155">${body}</div>
    ${
      cta
        ? `<a href="${cta.url}" style="display:inline-block;margin-top:24px;background:#16a34a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px">${cta.label}</a>
    <p style="font-size:13px;color:#64748b;margin-top:24px">If the button does not work, paste this into your browser:<br><span style="word-break:break-all">${cta.url}</span></p>`
        : ''
    }
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px">
    <p style="font-size:12px;color:#94a3b8;margin:0">You received this because you have an Eco account. Manage your notification settings at ${this.webOrigin}/settings/notifications.</p>
  </div>
</body></html>`;
  }

  async sendVerificationEmail(to: string, name: string, url: string): Promise<void> {
    await this.send(
      to,
      'Confirm your email address',
      this.layout(
        `Welcome to Eco, ${name}`,
        '<p>Confirm your email address to secure your account and turn on notifications. This link is valid for 24 hours.</p>',
        { label: 'Confirm email', url },
      ),
      `Welcome to Eco, ${name}. Confirm your email address: ${url}`,
    );
  }

  async sendPasswordResetEmail(to: string, name: string, url: string): Promise<boolean> {
    return this.send(
      to,
      'Reset your Eco password',
      this.layout(
        'Reset your password',
        `<p>Hi ${name}, we received a request to reset your password. This link is valid for one hour and can be used once.</p>
         <p><strong>If you did not request this, you can safely ignore this email</strong> — your password will not change.</p>`,
        { label: 'Reset password', url },
      ),
      `Reset your Eco password: ${url}`,
    );
  }

  async sendPasswordChangedNotice(to: string, name: string): Promise<void> {
    await this.send(
      to,
      'Your Eco password was changed',
      this.layout(
        'Your password was changed',
        `<p>Hi ${name}, your Eco password was just changed and every device has been signed out.</p>
         <p><strong>If this was not you, reset your password immediately</strong> and review your active sessions.</p>`,
        { label: 'Review account security', url: `${this.webOrigin}/settings/security` },
      ),
      'Your Eco password was changed. If this was not you, reset it immediately.',
    );
  }

  /**
   * Sent when someone tries to register with an address that already exists.
   * The registration endpoint returns the same neutral message either way, so
   * this note is what tells the real owner that someone tried.
   */
  async sendDuplicateRegistrationNotice(to: string): Promise<void> {
    await this.send(
      to,
      'Someone tried to sign up with your email',
      this.layout(
        'An account already exists',
        `<p>Someone just tried to create an Eco account with this email address. You already have one.</p>
         <p>If that was you, sign in instead — or reset your password if you have forgotten it.</p>`,
        { label: 'Sign in', url: `${this.webOrigin}/login` },
      ),
      `An Eco account already exists for this address. Sign in at ${this.webOrigin}/login`,
    );
  }

  async sendNotification(
    to: string,
    subject: string,
    heading: string,
    body: string,
    actionUrl?: string,
  ): Promise<void> {
    await this.send(
      to,
      subject,
      this.layout(
        heading,
        `<p>${body}</p>`,
        actionUrl ? { label: 'Open Eco', url: `${this.webOrigin}${actionUrl}` } : undefined,
      ),
      `${heading}\n\n${body}`,
    );
  }
}
