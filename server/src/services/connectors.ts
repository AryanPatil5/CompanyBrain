/**
 * Connector Adapters — Normalize source-specific payloads into a unified ThreadPayload.
 * Each source (Slack, GitHub, Linear) gets a normalizer that maps its webhook format
 * into the common schema used by the ingestion pipeline.
 */

export interface ThreadPayload {
  workspace_id: string;
  source: 'slack' | 'github' | 'linear';
  external_thread_id: string;
  channel_or_project: string;
  messages: Array<{ user: string; text: string; timestamp?: string }>;
}

/**
 * Normalize a raw Slack webhook payload.
 * Expected body: { workspace_id, source, external_thread_id, channel_or_project, messages[] }
 */
export function normalizeSlack(body: any): ThreadPayload | null {
  const { workspace_id, external_thread_id, channel_or_project, messages } = body;

  if (!workspace_id || !external_thread_id || !Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  return {
    workspace_id,
    source: 'slack',
    external_thread_id,
    channel_or_project: channel_or_project || 'general',
    messages: messages.map((m: any) => ({
      user: m.user || 'Unknown',
      text: m.text || '',
      timestamp: m.timestamp || m.ts,
    })),
  };
}

/**
 * Normalize a GitHub Issues/PR webhook payload.
 *
 * Supports two patterns:
 *  A) GitHub webhook (action: "created" on issue_comment or issues)
 *  B) Manual push with pre-formatted messages
 *
 * For GitHub webhooks, extracts the issue/PR body + all comments into messages.
 */
export function normalizeGitHub(body: any): ThreadPayload | null {
  // Pattern B: manual push with pre-formatted payload
  if (body.workspace_id && body.messages && Array.isArray(body.messages)) {
    return {
      workspace_id: body.workspace_id,
      source: 'github',
      external_thread_id: body.external_thread_id || `gh-${Date.now()}`,
      channel_or_project: body.channel_or_project || body.repository || 'unknown-repo',
      messages: body.messages.map((m: any) => ({
        user: m.user || 'Unknown',
        text: m.text || '',
        timestamp: m.timestamp,
      })),
    };
  }

  // Pattern A: native GitHub webhook payload
  const issue = body.issue || body.pull_request;
  if (!issue) return null;

  const repo = body.repository?.full_name || 'unknown-repo';
  const workspaceId = body.workspace_id || body.installation?.id?.toString() || 'default';
  const threadId = `gh-${repo}-${issue.number}`;

  const messages: ThreadPayload['messages'] = [];

  // Issue/PR body as first message
  if (issue.body) {
    messages.push({
      user: issue.user?.login || 'author',
      text: issue.body,
      timestamp: issue.created_at,
    });
  }

  // If this is a comment event, add the comment
  if (body.comment) {
    messages.push({
      user: body.comment.user?.login || 'commenter',
      text: body.comment.body || '',
      timestamp: body.comment.created_at,
    });
  }

  // If comments array is provided (pre-fetched), add them all
  if (Array.isArray(body.comments)) {
    for (const c of body.comments) {
      messages.push({
        user: c.user?.login || 'commenter',
        text: c.body || '',
        timestamp: c.created_at,
      });
    }
  }

  if (messages.length === 0) return null;

  return {
    workspace_id: workspaceId,
    source: 'github',
    external_thread_id: threadId,
    channel_or_project: repo,
    messages,
  };
}

/**
 * Normalize a Linear issue webhook payload.
 *
 * Supports two patterns:
 *  A) Linear webhook (action: "create"/"update" on Issue/Comment)
 *  B) Manual push with pre-formatted messages
 *
 * For Linear webhooks, extracts the issue description + comments into messages.
 */
export function normalizeLinear(body: any): ThreadPayload | null {
  // Pattern B: manual push with pre-formatted payload
  if (body.workspace_id && body.messages && Array.isArray(body.messages)) {
    return {
      workspace_id: body.workspace_id,
      source: 'linear',
      external_thread_id: body.external_thread_id || `lin-${Date.now()}`,
      channel_or_project: body.channel_or_project || body.team || 'unknown-team',
      messages: body.messages.map((m: any) => ({
        user: m.user || 'Unknown',
        text: m.text || '',
        timestamp: m.timestamp,
      })),
    };
  }

  // Pattern A: native Linear webhook payload
  const data = body.data;
  if (!data) return null;

  const workspaceId = body.workspace_id || body.organizationId || 'default';
  const teamKey = data.team?.key || data.teamId || 'unknown-team';
  const issueId = data.id || data.issueId || `lin-${Date.now()}`;
  const threadId = `lin-${issueId}`;

  const messages: ThreadPayload['messages'] = [];

  // Issue description as first message
  if (data.description) {
    messages.push({
      user: data.creator?.name || data.creatorId || 'author',
      text: data.description,
      timestamp: data.createdAt,
    });
  }

  // Comment body (if this is a Comment webhook)
  if (data.body && body.type === 'Comment') {
    messages.push({
      user: data.user?.name || data.userId || 'commenter',
      text: data.body,
      timestamp: data.createdAt,
    });
  }

  // Pre-fetched comments array
  if (Array.isArray(body.comments)) {
    for (const c of body.comments) {
      messages.push({
        user: c.user?.name || c.userName || 'commenter',
        text: c.body || c.text || '',
        timestamp: c.createdAt,
      });
    }
  }

  if (messages.length === 0) return null;

  return {
    workspace_id: workspaceId,
    source: 'linear',
    external_thread_id: threadId,
    channel_or_project: teamKey,
    messages,
  };
}
