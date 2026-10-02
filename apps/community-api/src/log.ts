// SPDX-License-Identifier: AGPL-3.0-or-later

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Values a log line may carry. No objects: a whole record or request body can never be logged by accident. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * One JSON object per line. Log events and ids (tenant, record, job), counts and statuses, never a person's
 * name, email, phone, the text they wrote, a token or a key: logs are copied, shipped and kept far longer
 * than the data they describe.
 */
export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const at =
    (l: LogLevel) =>
    (event: string, fields: LogFields = {}) => {
      if (RANK[l] < RANK[level]) return;
      write(JSON.stringify({ t: now().toISOString(), level: l, event, ...fields }));
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** An error's class and message only. Messages from our code and TwentyClient carry no secrets or bodies. */
export const errorFields = (error: unknown): LogFields => ({
  error: error instanceof Error ? error.name : 'Error',
  message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
});

export const silentLogger: Logger = createLogger('error', () => undefined);
