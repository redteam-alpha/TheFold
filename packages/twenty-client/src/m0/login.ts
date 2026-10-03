// SPDX-License-Identifier: AGPL-3.0-or-later
import { dig } from './json.js';

/**
 * Signs in as a Twenty user with an email and password, to get the access token that user's browser would hold.
 * The M0 privacy checks need it: a person's role is not assignable to an API key, so the only way to ask Twenty
 * "what can a Church staff user read?" is to be one.
 *
 * Two GraphQL mutations on `POST /metadata`. Their names and argument and result shapes come from the generated
 * schema in `twenty-client-sdk@2.43.0` (`getLoginTokenFromCredentials` and `getAuthTokensFromLoginToken`); how a
 * live server answers is verified by running the harness, and a failure here says so rather than guessing.
 *
 * The password and the tokens are credentials: they are never logged, never put in an error message, and an error
 * from the server is scrubbed of them before it is shown.
 */
export class TwentyLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwentyLoginError';
  }
}

export interface LoginOptions {
  /** The server's own URL, e.g. `http://localhost:3000`. Also sent as the `origin` argument. */
  baseUrl: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const LOGIN_TOKEN = `mutation ($email: String!, $password: String!, $origin: String!) {
  getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) {
    loginToken { token }
  }
}`;

const AUTH_TOKENS = `mutation ($loginToken: String!, $origin: String!) {
  getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
    tokens { accessOrWorkspaceAgnosticToken { token } }
  }
}`;

interface GraphQlBody {
  data?: Record<string, unknown> | null;
  errors?: { message?: unknown }[];
}

/** Replaces every secret in `text`, whatever the server chose to echo back. */
function scrub(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((t, s) => t.split(s).join('***'), text);
}

export async function loginWithPassword(o: LoginOptions): Promise<string> {
  const doFetch = o.fetch ?? fetch;
  const origin = new URL(o.baseUrl).origin;
  const secrets = [o.password];

  const call = async (query: string, variables: Record<string, string>): Promise<GraphQlBody> => {
    let res: Response;
    try {
      res = await doFetch(new URL('/metadata', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch (cause) {
      throw new TwentyLoginError(
        `sign-in did not complete (${cause instanceof Error ? scrub(cause.message, secrets) : 'network error'})`,
      );
    }
    if (!res.ok) throw new TwentyLoginError(`sign-in was refused with HTTP ${res.status}`);
    try {
      return (await res.json()) as GraphQlBody;
    } catch {
      throw new TwentyLoginError('sign-in answered with something that is not JSON');
    }
  };

  const fail = (body: GraphQlBody, what: string): never => {
    const first = body.errors?.[0]?.message;
    const reason =
      typeof first === 'string' ? scrub(first, secrets).slice(0, 200) : 'no reason given';
    throw new TwentyLoginError(`${what} failed: ${reason}`);
  };

  const first = await call(LOGIN_TOKEN, { email: o.email, password: o.password, origin });
  const loginToken = dig(first, 'data', 'getLoginTokenFromCredentials', 'loginToken', 'token');
  if (typeof loginToken !== 'string' || loginToken === '')
    return fail(first, 'asking for a login token');
  secrets.push(loginToken);

  const second = await call(AUTH_TOKENS, { loginToken, origin });
  const access = dig(
    second,
    'data',
    'getAuthTokensFromLoginToken',
    'tokens',
    'accessOrWorkspaceAgnosticToken',
    'token',
  );
  if (typeof access !== 'string' || access === '')
    return fail(second, 'exchanging the login token');
  return access;
}
