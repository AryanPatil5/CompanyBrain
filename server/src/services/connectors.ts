/**
 * Connector Adapters — Normalize source-specific payloads into a unified ThreadPayload.
 * Supports: Slack, GitHub, Linear, Zendesk, Inbound Email, Database Schemas, and Direct Tacit Knowledge ("Teach the Brain").
 */

export interface ThreadPayload {
  workspace_id: string;
  source: 'slack' | 'github' | 'linear' | 'zendesk' | 'email' | 'database' | 'direct_teach';
  external_thread_id: string;
  channel_or_project: string;
  messages: Array<{ user: string; text: string; timestamp?: string }>;
}

/**
 * Normalize a raw Slack webhook payload.
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
 */
export function normalizeGitHub(body: any): ThreadPayload | null {
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

  const issue = body.issue || body.pull_request;
  if (!issue) return null;

  const repo = body.repository?.full_name || 'unknown-repo';
  const workspaceId = body.workspace_id || body.installation?.id?.toString() || 'default';
  const threadId = `gh-${repo}-${issue.number}`;

  const messages: ThreadPayload['messages'] = [];

  if (issue.body) {
    messages.push({
      user: issue.user?.login || 'author',
      text: issue.body,
      timestamp: issue.created_at,
    });
  }

  if (body.comment) {
    messages.push({
      user: body.comment.user?.login || 'commenter',
      text: body.comment.body || '',
      timestamp: body.comment.created_at,
    });
  }

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
 */
export function normalizeLinear(body: any): ThreadPayload | null {
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

  const data = body.data;
  if (!data) return null;

  const workspaceId = body.workspace_id || body.organizationId || 'default';
  const teamKey = data.team?.key || data.teamId || 'unknown-team';
  const issueId = data.id || data.issueId || `lin-${Date.now()}`;
  const threadId = `lin-${issueId}`;

  const messages: ThreadPayload['messages'] = [];

  if (data.description) {
    messages.push({
      user: data.creator?.name || data.creatorId || 'author',
      text: data.description,
      timestamp: data.createdAt,
    });
  }

  if (data.body && body.type === 'Comment') {
    messages.push({
      user: data.user?.name || data.userId || 'commenter',
      text: data.body,
      timestamp: data.createdAt,
    });
  }

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

/**
 * Normalize a Zendesk / Support Ticket webhook payload.
 */
export function normalizeZendesk(body: any): ThreadPayload | null {
  if (body.workspace_id && body.messages && Array.isArray(body.messages)) {
    return {
      workspace_id: body.workspace_id,
      source: 'zendesk',
      external_thread_id: body.external_thread_id || `zen-${Date.now()}`,
      channel_or_project: body.channel_or_project || body.group || 'customer-support',
      messages: body.messages.map((m: any) => ({
        user: m.user || 'Agent/Customer',
        text: m.text || '',
        timestamp: m.timestamp,
      })),
    };
  }

  const ticket = body.ticket || body;
  if (!ticket || !ticket.id) return null;

  const workspaceId = body.workspace_id || 'default';
  const threadId = `zen-ticket-${ticket.id}`;
  const group = ticket.group_name || 'support';

  const messages: ThreadPayload['messages'] = [];

  if (ticket.description || ticket.subject) {
    messages.push({
      user: ticket.requester_name || 'Customer',
      text: `Subject: ${ticket.subject || ''}\n${ticket.description || ''}`,
      timestamp: ticket.created_at,
    });
  }

  if (Array.isArray(ticket.comments)) {
    for (const c of ticket.comments) {
      messages.push({
        user: c.author_name || (c.public ? 'Customer' : 'Support Agent'),
        text: c.body || '',
        timestamp: c.created_at,
      });
    }
  }

  if (messages.length === 0) return null;

  return {
    workspace_id: workspaceId,
    source: 'zendesk',
    external_thread_id: threadId,
    channel_or_project: group,
    messages,
  };
}

/**
 * Normalize Inbound Email thread payloads.
 */
export function normalizeEmail(body: any): ThreadPayload | null {
  const { workspace_id, external_thread_id, subject, messages, from } = body;

  if (body.workspace_id && Array.isArray(messages)) {
    return {
      workspace_id: body.workspace_id,
      source: 'email',
      external_thread_id: external_thread_id || `email-${Date.now()}`,
      channel_or_project: subject || 'inbox',
      messages: messages.map((m: any) => ({
        user: m.user || m.from || 'Sender',
        text: m.text || m.body || '',
        timestamp: m.timestamp,
      })),
    };
  }

  if (!body.body && !body.text) return null;

  return {
    workspace_id: workspace_id || 'default',
    source: 'email',
    external_thread_id: external_thread_id || `email-${Date.now()}`,
    channel_or_project: subject || 'inbox',
    messages: [
      {
        user: from || 'Sender',
        text: `Subject: ${subject || ''}\n${body.body || body.text || ''}`,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Normalize Database Schema / Runbook Queries payloads.
 */
export function normalizeDatabase(body: any): ThreadPayload | null {
  const { workspace_id, database_name, runbook_name, queries, notes } = body;

  if (body.workspace_id && Array.isArray(body.messages)) {
    return {
      workspace_id: body.workspace_id,
      source: 'database',
      external_thread_id: body.external_thread_id || `db-${Date.now()}`,
      channel_or_project: database_name || 'postgres',
      messages: body.messages,
    };
  }

  if (!notes && !queries) return null;

  return {
    workspace_id: workspace_id || 'default',
    source: 'database',
    external_thread_id: `db-${database_name || 'main'}-${Date.now()}`,
    channel_or_project: database_name || 'postgres',
    messages: [
      {
        user: 'Database Engineer',
        text: `Runbook: ${runbook_name || 'Operational Query Procedure'}\nNotes: ${notes || ''}\nQueries: ${JSON.stringify(queries || [])}`,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Normalize Direct Tacit Knowledge Dictation ("Teach the Brain").
 */
export function normalizeDirectTeach(body: any): ThreadPayload | null {
  const { workspace_id, title, category, author, description, steps } = body;

  if (!title || !description) return null;

  const formattedSteps = Array.isArray(steps) && steps.length > 0
    ? steps.map((s: any, i: number) => `Step ${i + 1}: ${typeof s === 'string' ? s : s.instruction || s.action}`).join('\n')
    : '';

  return {
    workspace_id: workspace_id || '00000000-0000-0000-0000-000000000000',
    source: 'direct_teach',
    external_thread_id: `teach-${Date.now()}`,
    channel_or_project: category || 'Tacit Knowledge',
    messages: [
      {
        user: author || 'Senior Domain Expert',
        text: `EXPLICIT OPERATIONAL SOP DECREE: ${title}\nCategory: ${category || 'Operations'}\nScenario: ${description}\n\nConfirmed Steps:\n${formattedSteps}`,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
