// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MailMessage } from './mailer.js';

/**
 * The sign-in email. Plain and honest: it says what it is, who asked (the person themselves, we hope), and
 * what happens if they did not. It is a system message, so it does not pretend to come from a person.
 */
export function signInEmail(p: {
  to: string;
  churchName: string;
  link: string;
  minutes: number;
}): MailMessage {
  return {
    to: p.to,
    subject: `Your sign-in link for ${p.churchName}`,
    text: [
      'Hello,',
      '',
      `Someone (we hope it was you) asked to sign in to ${p.churchName}'s community pages with this email address.`,
      '',
      `Sign in: ${p.link}`,
      '',
      `The link works once, within ${p.minutes} minutes.`,
      'If you did not ask for it, you can ignore this email: nothing happens unless the link is used.',
      '',
      `This message was sent automatically by The Fold for ${p.churchName}.`,
    ].join('\n'),
  };
}
