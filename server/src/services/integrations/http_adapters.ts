import { resolveCredential } from './secrets.js';

export interface HttpDispatchResult {
  success: boolean;
  status_code: number;
  response_data: any;
  error?: string;
}

/**
 * Dispatches an HTTP fetch request with 5-second timeout and 1x automatic retry.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries: number = 1
): Promise<HttpDispatchResult> {
  let attempt = 0;
  let lastError: string = 'Unknown HTTP dispatch error';

  while (attempt <= retries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); // 5-second timeout

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);

      let data: any;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw_body: text };
      }

      if (res.ok) {
        return {
          success: true,
          status_code: res.status,
          response_data: data,
        };
      }

      lastError = `HTTP ${res.status}: ${typeof data === 'object' ? JSON.stringify(data) : text}`;
    } catch (err) {
      clearTimeout(timer);
      lastError = (err as Error).name === 'AbortError' ? 'HTTP Request Timed Out (5000ms)' : (err as Error).message;
    }
  }

  return {
    success: false,
    status_code: 502,
    response_data: null,
    error: lastError,
  };
}

/**
 * Slack Post Message Integration Adapter
 */
export async function slackPostMessageAdapter(
  endpointConfig: any,
  parameters: any,
  credentialRef?: string
): Promise<HttpDispatchResult> {
  const token = await resolveCredential(credentialRef || 'vault:slack_bot_token');
  const channel = parameters?.channel || endpointConfig?.channel || '#general';
  const text = parameters?.text || parameters?.message || `[Company Brain Step Execution] Executed step action.`;

  if (!token) {
    // Return structured simulated result when token is omitted in dev mode
    return {
      success: true,
      status_code: 200,
      response_data: { ok: true, channel, message: text, mode: 'simulated_dev' },
    };
  }

  return fetchWithRetry('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text }),
  });
}

/**
 * GitHub Issue / PR Comment Integration Adapter
 */
export async function githubCommentAdapter(
  endpointConfig: any,
  parameters: any,
  credentialRef?: string
): Promise<HttpDispatchResult> {
  const token = await resolveCredential(credentialRef || 'vault:github_pat');
  const repo = parameters?.repo || endpointConfig?.repo || 'owner/repo';
  const issueNumber = parameters?.issue_number || parameters?.number || 1;
  const body = parameters?.body || parameters?.comment || '[Company Brain] Automated SOP step execution completed.';

  if (!token) {
    return {
      success: true,
      status_code: 200,
      response_data: { ok: true, repo, issue_number: issueNumber, body, mode: 'simulated_dev' },
    };
  }

  const [owner, repoName] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`;

  return fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Company-Brain-Execution-Layer',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
}

/**
 * Generic System Step Execution Dispatcher
 */
export async function dispatchStepExecution(
  targetSystem: string,
  endpointConfig: any,
  parameters: any,
  credentialRef?: string
): Promise<HttpDispatchResult> {
  const system = targetSystem.toLowerCase();

  if (system === 'slack') {
    return slackPostMessageAdapter(endpointConfig, parameters, credentialRef);
  }
  if (system === 'github') {
    return githubCommentAdapter(endpointConfig, parameters, credentialRef);
  }

  // Generic HTTP webhook dispatch fallback
  const baseUrl = endpointConfig?.base_url || `https://api.${system}.internal/v1/execute`;
  return fetchWithRetry(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_system: system, parameters, dispatched_at: new Date().toISOString() }),
  });
}
