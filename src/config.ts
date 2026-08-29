/**
 * Application configuration, loaded from environment variables at startup.
 * The service is stateless: everything it needs to talk to Asana (token,
 * workspace, custom-field GIDs) is provided here.
 */

import { DEFAULT_SHORT_ID_PATTERN } from './utils/shortId.js';

/** GIDs of the "PR Status" dropdown options in Asana. */
export interface PrStatusOptionGids {
  open: string;
  merged: string;
  closed: string;
}

/** GIDs of the "CI Status" dropdown options in Asana. */
export interface CiStatusOptionGids {
  pending: string;
  passed: string;
  failed: string;
}

export interface AsanaConfig {
  accessToken: string;
  workspaceGid: string;
  /** Text custom field storing the Jira-style ticket key (e.g. "CENG-1234"). */
  ticketKeyFieldGid: string;
  /** Dropdown custom field reflecting pull request state. */
  prStatusFieldGid: string;
  prStatusOptions: PrStatusOptionGids;
  /** Dropdown custom field reflecting CI state. */
  ciStatusFieldGid: string;
  ciStatusOptions: CiStatusOptionGids;
}

export interface Config {
  port: number;
  githubWebhookSecret: string;
  /** Pattern used to extract short-IDs from branches, titles, and commits. */
  shortIdPattern: RegExp;
  asana: AsanaConfig;
}

/**
 * Loads and validates configuration, failing fast with a single error that
 * lists every missing variable — friendlier for first-time deployments than
 * discovering them one at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];

  const requireVar = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      missing.push(name);
      return '';
    }
    return value;
  };

  const port = Number.parseInt(env.PORT ?? '8080', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got: ${env.PORT}`);
  }

  const config: Config = {
    port,
    githubWebhookSecret: requireVar('GITHUB_WEBHOOK_SECRET'),
    shortIdPattern: compileShortIdPattern(env.SHORT_ID_PATTERN),
    asana: {
      accessToken: requireVar('ASANA_ACCESS_TOKEN'),
      workspaceGid: requireVar('ASANA_WORKSPACE_GID'),
      ticketKeyFieldGid: requireVar('ASANA_TICKET_KEY_FIELD_GID'),
      prStatusFieldGid: requireVar('ASANA_PR_STATUS_FIELD_GID'),
      prStatusOptions: {
        open: requireVar('ASANA_PR_STATUS_OPEN_GID'),
        merged: requireVar('ASANA_PR_STATUS_MERGED_GID'),
        closed: requireVar('ASANA_PR_STATUS_CLOSED_GID'),
      },
      ciStatusFieldGid: requireVar('ASANA_CI_STATUS_FIELD_GID'),
      ciStatusOptions: {
        pending: requireVar('ASANA_CI_STATUS_PENDING_GID'),
        passed: requireVar('ASANA_CI_STATUS_PASSED_GID'),
        failed: requireVar('ASANA_CI_STATUS_FAILED_GID'),
      },
    },
  };

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return config;
}

function compileShortIdPattern(raw: string | undefined): RegExp {
  if (!raw) {
    return DEFAULT_SHORT_ID_PATTERN;
  }
  try {
    // Case-insensitive; the `g` flag is intentionally not used (stateful).
    return new RegExp(raw, 'i');
  } catch (error) {
    throw new Error(
      `SHORT_ID_PATTERN is not a valid regular expression: ${(error as Error).message}`,
    );
  }
}
