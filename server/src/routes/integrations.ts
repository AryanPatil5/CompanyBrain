import { Router, Request, Response } from 'express';
import { authenticate, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabase } from '../config/supabase.js';
import { storeIntegrationCredential, getIntegrationCredential } from '../services/integrations/secrets.js';

const router = Router();

// Base application URLs for OAuth redirects
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5001';
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'http://localhost:3000';

// ─── Stage 4: Live Connection Status & Disconnect ──────────────────────

router.get('/status', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;

    const { data: credentials } = await supabase
      .from('integration_credentials')
      .select('provider, external_org_id, status, connected_at')
      .eq('workspace_id', workspaceId);

    const { data: installations } = await supabase
      .from('integration_installations')
      .select('provider, external_org_id')
      .eq('workspace_id', workspaceId);

    const credentialMap = new Map((credentials || []).map((c) => [c.provider, c]));
    const installationMap = new Map((installations || []).map((i) => [i.provider, i]));

    const providers = ['slack', 'github', 'gmail', 'zendesk', 'linear', 'database', 'stripe'];

    const result = providers.map((provider) => {
      const cred = credentialMap.get(provider);
      const inst = installationMap.get(provider);

      let isConnected = false;
      let displayStatus = 'Not Connected';

      if (cred?.status === 'connected' || inst) {
        isConnected = true;
        displayStatus = 'Active';
      } else if (process.env[`${provider.toUpperCase()}_BOT_TOKEN`] || process.env[`${provider.toUpperCase()}_API_TOKEN`]) {
        isConnected = true;
        displayStatus = 'Configured via .env';
      }

      return {
        provider,
        connected: isConnected,
        status: displayStatus,
        external_org_id: cred?.external_org_id || inst?.external_org_id || null,
        connected_at: cred?.connected_at || null,
      };
    });

    res.json({ success: true, workspace_id: workspaceId, integrations: result });
  } catch (err) {
    console.error('[Integrations Error] Failed to fetch status:', err);
    res.status(500).json({ error: 'Internal server error while fetching integration status.' });
  }
});

router.post('/:provider/disconnect', authenticate, requireRole(['admin']), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const { provider } = req.params;

    // Delete credentials & installations for provider and workspace
    await supabase.from('integration_credentials').delete().eq('workspace_id', user.workspace_id).eq('provider', provider);
    await supabase.from('integration_installations').delete().eq('workspace_id', user.workspace_id).eq('provider', provider);

    res.json({ success: true, message: `Disconnected ${provider} integration successfully.` });
  } catch (err) {
    res.status(500).json({ error: `Failed to disconnect ${req.params.provider} integration.` });
  }
});

// ─── Stage 1: Slack OAuth Flow ──────────────────────────────────────────

router.get('/slack/connect', authenticate, requireRole(['admin']), (req: Request, res: Response): void => {
  const user = (req as AuthenticatedRequest).user!;
  const state = encodeURIComponent(JSON.stringify({ workspace_id: user.workspace_id }));
  const clientId = process.env.SLACK_CLIENT_ID || 'mock-slack-client-id';

  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'channels:history,channels:read,chat:write',
    redirect_uri: `${APP_BASE_URL}/api/integrations/slack/callback`,
    state,
  });

  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

router.get('/slack/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { code, state } = req.query as { code: string; state: string };
    if (!state) {
      res.redirect(`${CLIENT_BASE_URL}?error=slack_missing_state`);
      return;
    }

    const { workspace_id } = JSON.parse(decodeURIComponent(state));
    const clientId = process.env.SLACK_CLIENT_ID || '';
    const clientSecret = process.env.SLACK_CLIENT_SECRET || '';

    // Mock mode fallback for local dev/testing if OAuth keys are unset
    let teamId = 'T_DEMO_SLACK_ORG';
    let accessToken = 'xoxb-mock-demo-slack-token';

    if (clientId && clientSecret && code) {
      const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: `${APP_BASE_URL}/api/integrations/slack/callback`,
        }),
      });
      const data = await tokenRes.json();

      if (!data.ok) {
        res.redirect(`${CLIENT_BASE_URL}?error=slack_oauth_failed`);
        return;
      }
      teamId = data.team?.id || teamId;
      accessToken = data.access_token || accessToken;
    }

    await storeIntegrationCredential({
      workspace_id,
      provider: 'slack',
      external_org_id: teamId,
      access_token: accessToken,
    });

    await supabase.from('integration_installations').upsert(
      { workspace_id, provider: 'slack', external_org_id: teamId },
      { onConflict: 'provider, external_org_id' }
    );

    res.redirect(`${CLIENT_BASE_URL}?connected=slack`);
  } catch (err) {
    console.error('[Slack Callback Error]:', err);
    res.redirect(`${CLIENT_BASE_URL}?error=slack_callback_error`);
  }
});

// ─── Stage 2: GitHub App Installation Flow ───────────────────────────────

router.get('/github/connect', authenticate, requireRole(['admin']), (req: Request, res: Response): void => {
  const user = (req as AuthenticatedRequest).user!;
  const state = encodeURIComponent(JSON.stringify({ workspace_id: user.workspace_id }));
  const appName = process.env.GITHUB_APP_NAME || 'company-brain-app';

  res.redirect(`https://github.com/apps/${appName}/installations/new?state=${state}`);
});

router.get('/github/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { installation_id, state } = req.query as { installation_id: string; state: string };
    const workspace_id = state ? JSON.parse(decodeURIComponent(state)).workspace_id : '00000000-0000-0000-0000-000000000000';
    const installId = installation_id || 'gh_inst_demo_99';

    await storeIntegrationCredential({
      workspace_id,
      provider: 'github',
      external_org_id: installId,
    });

    await supabase.from('integration_installations').upsert(
      { workspace_id, provider: 'github', external_org_id: installId },
      { onConflict: 'provider, external_org_id' }
    );

    res.redirect(`${CLIENT_BASE_URL}?connected=github`);
  } catch (err) {
    console.error('[GitHub Callback Error]:', err);
    res.redirect(`${CLIENT_BASE_URL}?error=github_callback_error`);
  }
});

// ─── Stage 3: Gmail OAuth Flow & Token Exchange ─────────────────────────

router.get('/gmail/connect', authenticate, requireRole(['admin']), (req: Request, res: Response): void => {
  const user = (req as AuthenticatedRequest).user!;
  const state = encodeURIComponent(JSON.stringify({ workspace_id: user.workspace_id }));
  const clientId = process.env.GOOGLE_CLIENT_ID || 'mock-google-client-id';

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${APP_BASE_URL}/api/integrations/gmail/callback`,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/gmail/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { code, state } = req.query as { code: string; state: string };
    if (!state) {
      res.redirect(`${CLIENT_BASE_URL}?error=gmail_missing_state`);
      return;
    }

    const { workspace_id } = JSON.parse(decodeURIComponent(state));
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

    let accessToken = 'ya29.mock-gmail-access-token';
    let refreshToken = '1//mock-gmail-refresh-token';

    if (clientId && clientSecret && code) {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: `${APP_BASE_URL}/api/integrations/gmail/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      accessToken = tokens.access_token || accessToken;
      refreshToken = tokens.refresh_token || refreshToken;
    }

    await storeIntegrationCredential({
      workspace_id,
      provider: 'gmail',
      external_org_id: workspace_id,
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    res.redirect(`${CLIENT_BASE_URL}?connected=gmail`);
  } catch (err) {
    console.error('[Gmail Callback Error]:', err);
    res.redirect(`${CLIENT_BASE_URL}?error=gmail_callback_error`);
  }
});

export default router;
