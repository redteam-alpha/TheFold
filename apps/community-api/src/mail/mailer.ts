// SPDX-License-Identifier: AGPL-3.0-or-later
import { createTransport } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only: no tracking pixels, no remote images, nothing that reports back when it is opened. */
  text: string;
}

/** The one way community-api sends email. Member-facing mail never goes through Twenty (privacy-and-safety.md). */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS (usually port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** e.g. `"Grace Church via The Fold" <no-reply@thefold.app>` */
  from: string;
}

export function smtpMailer(s: SmtpSettings): Mailer {
  const transport = createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    ...(s.user ? { auth: { user: s.user, pass: s.password ?? '' } } : {}),
  });
  return {
    async send(m) {
      await transport.sendMail({ from: s.from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
