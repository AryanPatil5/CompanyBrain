import { logger } from '../logger.js';
import { supabase } from '../config/supabase.js';

/**
 * Administrative provisioning utility to create a Supabase Auth user
 * and assign their workspace_id and role in user_workspace_roles table.
 */
export async function provisionUser(
  email: string,
  password?: string,
  workspaceId: string = '00000000-0000-0000-0000-000000000000',
  role: 'admin' | 'approver' | 'member' = 'admin'
) {
  logger.info(`[Provisioning] Creating user ${email} in workspace ${workspaceId} with role ${role}...`);

  const userPassword = password || `TempPass_${Math.random().toString(36).slice(2)}!9`;

  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password: userPassword,
    email_confirm: true,
  });

  if (authErr || !authData?.user) {
    logger.error('[Provisioning Error] Failed to create auth user:', authErr);
    return null;
  }

  const userId = authData.user.id;

  const { data: roleData, error: roleErr } = await supabase
    .from('user_workspace_roles')
    .upsert({
      user_id: userId,
      workspace_id: workspaceId,
      role,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (roleErr) {
    logger.error('[Provisioning Error] Failed to assign workspace role:', roleErr);
    return null;
  }

  logger.info(`[Provisioning Success] Provisioned user ID ${userId} with temporary password: ${userPassword}`);
  return { user: authData.user, roleMapping: roleData };
}

// CLI runner if invoked directly
if (process.argv[1]?.includes('provision_user')) {
  const email = process.argv[2] || `admin_${Date.now()}@example.com`;
  const role = (process.argv[3] as any) || 'admin';
  provisionUser(email, 'Password123!', '00000000-0000-0000-0000-000000000000', role);
}
