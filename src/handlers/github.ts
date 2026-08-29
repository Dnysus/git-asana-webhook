/**
 * GitHub webhook payload parsing and routing.
 *
 * Only `pull_request` and `workflow_run` events are processed; everything
 * else is acknowledged and ignored. Each handler:
 *   1. extracts a Jira-style short-ID (branch name first, then title/commit),
 *   2. looks up the Asana task via the "Ticket Key" custom field,
 *   3. updates the relevant dropdown custom field and posts a comment
 *      when the event warrants one (PR opened/merged, CI failed).
 */

import type { PullRequestEvent, WorkflowRunEvent } from '@octokit/webhooks-types';

import type { AsanaClient } from '../asana/client.js';
import type { Config } from '../config.js';
import { logger } from '../utils/logger.js';
import { extractShortId } from '../utils/shortId.js';

export interface HandlerContext {
  asana: AsanaClient;
  config: Config;
}

/** Summary of what the service did with a delivery (echoed back to GitHub). */
export interface HandlerResult {
  outcome: 'processed' | 'ignored';
  reason?: string;
  shortId?: string;
  taskGid?: string;
}

/** A resolved update: which dropdown option to set, plus an optional comment. */
interface TaskUpdate {
  fieldGid: string;
  optionGid: string;
  /** Inner HTML for an Asana story; omitted when no comment should be posted. */
  commentHtml?: string;
}

/** Workflow conclusions treated as a CI failure. */
const FAILURE_CONCLUSIONS: ReadonlyArray<string> = ['failure', 'timed_out', 'startup_failure'];

/** Routes a delivery by event name. Unsupported events are ignored politely. */
export async function handleGithubEvent(
  eventName: string,
  payload: unknown,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  switch (eventName) {
    case 'pull_request':
      return handlePullRequest(payload as PullRequestEvent, ctx);
    case 'workflow_run':
      return handleWorkflowRun(payload as WorkflowRunEvent, ctx);
    default:
      return { outcome: 'ignored', reason: `event "${eventName}" is not handled` };
  }
}

async function handlePullRequest(payload: PullRequestEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const pr = payload.pull_request;
  const shortId = extractShortId(ctx.config.shortIdPattern, [pr.head.ref, pr.title]);
  if (!shortId) {
    return { outcome: 'ignored', reason: 'no short-ID found in branch name or PR title' };
  }

  const update = resolvePrUpdate(payload, ctx.config);
  if (!update) {
    return { outcome: 'ignored', reason: `pull_request action "${payload.action}" not mapped`, shortId };
  }

  return applyUpdate(shortId, update, ctx);
}

async function handleWorkflowRun(payload: WorkflowRunEvent, ctx: HandlerContext): Promise<HandlerResult> {
  const run = payload.workflow_run;
  const shortId = extractShortId(ctx.config.shortIdPattern, [run.head_branch, run.head_commit?.message]);
  if (!shortId) {
    return { outcome: 'ignored', reason: 'no short-ID found in head branch or commit message' };
  }

  const update = resolveCiUpdate(payload, ctx.config);
  if (!update) {
    return { outcome: 'ignored', reason: `workflow_run ${describeRunState(payload)} not mapped`, shortId };
  }

  return applyUpdate(shortId, update, ctx);
}

/** Shared tail for both handlers: task lookup, field update, optional comment. */
async function applyUpdate(shortId: string, update: TaskUpdate, ctx: HandlerContext): Promise<HandlerResult> {
  const task = await ctx.asana.findTaskByTicketKey(ctx.config.asana.ticketKeyFieldGid, shortId);
  if (!task) {
    logger.info('No Asana task matched short-ID', { shortId });
    return { outcome: 'ignored', reason: 'no matching Asana task', shortId };
  }

  await ctx.asana.setEnumCustomField(task.gid, update.fieldGid, update.optionGid);
  if (update.commentHtml) {
    await ctx.asana.postComment(task.gid, update.commentHtml);
  }
  return { outcome: 'processed', shortId, taskGid: task.gid };
}

/**
 * Maps a pull_request action to a "PR Status" dropdown value:
 *   opened / reopened / ready_for_review → Open
 *   closed (merged)                      → Merged
 *   closed (not merged)                  → Closed
 * Comments are posted only for opened and merged, per the integration spec.
 */
function resolvePrUpdate(payload: PullRequestEvent, config: Config): TaskUpdate | null {
  const { prStatusFieldGid, prStatusOptions } = config.asana;
  const pr = payload.pull_request;
  const prLink = `<a href="${escapeHtml(pr.html_url)}">#${pr.number} ${escapeHtml(pr.title)}</a>`;
  const repo = escapeHtml(payload.repository.full_name);

  switch (payload.action) {
    case 'opened':
      return {
        fieldGid: prStatusFieldGid,
        optionGid: prStatusOptions.open,
        commentHtml: `<b>Pull request opened</b> by ${escapeHtml(pr.user.login)} in ${repo}: ${prLink}`,
      };
    case 'reopened':
    case 'ready_for_review':
      return { fieldGid: prStatusFieldGid, optionGid: prStatusOptions.open };
    case 'closed':
      if (payload.pull_request.merged) {
        const mergedBy = payload.pull_request.merged_by?.login ?? payload.sender.login;
        return {
          fieldGid: prStatusFieldGid,
          optionGid: prStatusOptions.merged,
          commentHtml: `<b>Pull request merged</b> by ${escapeHtml(mergedBy)} in ${repo}: ${prLink}`,
        };
      }
      return { fieldGid: prStatusFieldGid, optionGid: prStatusOptions.closed };
    default:
      return null;
  }
}

/**
 * Maps a workflow_run event to a "CI Status" dropdown value:
 *   requested / in_progress                  → Pending
 *   completed: success                       → Passed
 *   completed: failure / timeout / startup   → Failed (+ comment with run link)
 * Cancelled / skipped / neutral runs are deliberately left unmapped so they
 * never clobber a meaningful Passed/Failed state.
 */
function resolveCiUpdate(payload: WorkflowRunEvent, config: Config): TaskUpdate | null {
  const { ciStatusFieldGid, ciStatusOptions } = config.asana;
  const run = payload.workflow_run;

  if (payload.action === 'requested' || payload.action === 'in_progress') {
    return { fieldGid: ciStatusFieldGid, optionGid: ciStatusOptions.pending };
  }

  if (run.conclusion === 'success') {
    return { fieldGid: ciStatusFieldGid, optionGid: ciStatusOptions.passed };
  }

  if (run.conclusion !== null && FAILURE_CONCLUSIONS.includes(run.conclusion)) {
    const runLink = `<a href="${escapeHtml(run.html_url)}">${escapeHtml(run.name ?? 'Workflow')} #${run.run_number}</a>`;
    const branch = escapeHtml(run.head_branch ?? 'unknown branch');
    return {
      fieldGid: ciStatusFieldGid,
      optionGid: ciStatusOptions.failed,
      commentHtml: `<b>CI failed</b> on <b>${branch}</b> in ${escapeHtml(payload.repository.full_name)}: ${runLink}`,
    };
  }

  return null;
}

function describeRunState(payload: WorkflowRunEvent): string {
  return payload.action === 'completed'
    ? `conclusion "${payload.workflow_run.conclusion ?? 'unknown'}"`
    : `action "${payload.action}"`;
}

/** Escapes text interpolated into Asana `html_text` bodies. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
