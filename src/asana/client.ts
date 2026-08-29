/**
 * Minimal, typed Asana REST client covering exactly what this service needs:
 *   1. task search by "Ticket Key" custom field,
 *   2. dropdown (enum) custom-field updates,
 *   3. posting rich-text comments (stories).
 *
 * Built on the runtime's native `fetch` — no SDK dependency, keeping the
 * container image small and the surface area auditable.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://app.asana.com/api/1.0';
const REQUEST_TIMEOUT_MS = 10_000;
/** How many times a 429 (rate-limited) request is retried before giving up. */
const MAX_RATE_LIMIT_RETRIES = 2;

export interface AsanaClientOptions {
  accessToken: string;
  workspaceGid: string;
  /** Overridable for tests / mocking. */
  baseUrl?: string;
}

export interface AsanaTask {
  gid: string;
  name: string;
  permalink_url?: string;
}

interface AsanaListResponse<T> {
  data: T[];
}

/** Raised for any non-2xx Asana response (after rate-limit retries). */
export class AsanaApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Asana API responded with HTTP ${status}: ${responseBody.slice(0, 500)}`);
    this.name = 'AsanaApiError';
  }
}

export class AsanaClient {
  private readonly accessToken: string;
  private readonly workspaceGid: string;
  private readonly baseUrl: string;

  constructor(options: AsanaClientOptions) {
    this.accessToken = options.accessToken;
    this.workspaceGid = options.workspaceGid;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  /**
   * Finds the task whose text custom field (`ticketKeyFieldGid`) exactly
   * equals `ticketKey` (e.g. "CENG-1234"), returning the first match.
   *
   * Uses the workspace task-search API, which requires an Asana premium plan
   * and is eventually consistent — updates made seconds ago may lag briefly.
   */
  async findTaskByTicketKey(ticketKeyFieldGid: string, ticketKey: string): Promise<AsanaTask | null> {
    const query = new URLSearchParams({
      [`custom_fields.${ticketKeyFieldGid}.value`]: ticketKey,
      opt_fields: 'name,permalink_url',
    });
    const response = await this.request<AsanaListResponse<AsanaTask>>(
      'GET',
      `/workspaces/${this.workspaceGid}/tasks/search?${query.toString()}`,
    );

    const [task] = response.data;
    if (!task) {
      return null;
    }
    if (response.data.length > 1) {
      logger.warn('Multiple Asana tasks share the same ticket key; using the first match', {
        ticketKey,
        matchCount: response.data.length,
      });
    }
    return task;
  }

  /** Sets a dropdown (enum) custom field on a task to the given option. */
  async setEnumCustomField(taskGid: string, customFieldGid: string, enumOptionGid: string): Promise<void> {
    await this.request('PUT', `/tasks/${taskGid}`, {
      data: { custom_fields: { [customFieldGid]: enumOptionGid } },
    });
  }

  /**
   * Posts a comment (story) on a task. `innerHtml` is wrapped in the `<body>`
   * tags Asana's `html_text` format requires. Callers are responsible for
   * escaping any interpolated user content.
   */
  async postComment(taskGid: string, innerHtml: string): Promise<void> {
    await this.request('POST', `/tasks/${taskGid}/stories`, {
      data: { html_text: `<body>${innerHtml}</body>` },
    });
  }

  /** Sends an authenticated request, retrying politely on rate limits. */
  private async request<T = unknown>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number.parseFloat(response.headers.get('retry-after') ?? '');
        const waitSeconds = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 30) : 1;
        logger.warn('Asana rate limit hit; backing off before retry', { path, waitSeconds, attempt });
        await delay(waitSeconds * 1000);
        continue;
      }

      if (!response.ok) {
        throw new AsanaApiError(response.status, await response.text());
      }
      return (await response.json()) as T;
    }
  }
}
