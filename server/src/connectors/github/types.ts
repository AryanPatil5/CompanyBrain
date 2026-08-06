// Shared types for the GitHub connector (GitHub App auth, sync, webhooks).

export type GitHubDocumentType =
  | 'readme'
  | 'file'
  | 'issue'
  | 'pull_request'
  | 'discussion'
  | 'release'
  | 'wiki';

export const GITHUB_DOCUMENT_TYPES: readonly GitHubDocumentType[] = [
  'readme',
  'file',
  'issue',
  'pull_request',
  'discussion',
  'release',
  'wiki',
];

export type GithubSyncKind = 'initial' | 'incremental';

export type GithubSyncStatus = 'pending' | 'running' | 'completed' | 'error';

export interface GitHubInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
  targetType: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  permissions: Record<string, boolean>;
  updatedAt?: string;
}

export interface GithubSyncRequest {
  workspaceId: string;
  installationId: number;
  repoId: number;
  fullName: string;
  branch?: string;
  incremental?: boolean;
  include?: GitHubDocumentType[];
}

export interface GithubSyncStats {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
  deleted: number;
  durationMs: number;
  phases: Record<string, { indexed: number; skipped: number; failed: number }>;
}

export interface GithubResumeToken {
  phase?: string;
  position?: number;
  page?: number;
  cursor?: string;
  completedPhases: string[];
  lastProcessedAt?: string;
}

export interface GithubWebhookEventInput {
  event: string;
  deliveryId: string;
  payload: any;
  workspaceId?: string;
}

export interface GithubWebhookAction {
  kind: 'sync_repository' | 'sync_installation' | 'map_installation' | 'unmap_installation';
  installationId: number;
  repository?: { repoId: number; fullName: string; branch?: string };
}

export type GithubSyncJobName = 'sync_installation' | 'sync_repository' | 'webhook_event';

export interface GithubSyncInstallationJobData {
  workspaceId: string;
  installationId: number;
  repositories?: Array<{ repoId: number; fullName: string; branch?: string }>;
}

export interface GithubSyncRepositoryJobData {
  workspaceId: string;
  installationId: number;
  repoId: number;
  fullName: string;
  branch?: string;
  incremental?: boolean;
  include?: GitHubDocumentType[];
  trigger?: 'manual' | 'webhook' | 'installation';
}

export interface GithubWebhookJobData {
  workspaceId: string;
  event: string;
  deliveryId: string;
  payload: any;
}

export type GithubSyncJobData =
  | ({ job_name: 'sync_installation' } & GithubSyncInstallationJobData)
  | ({ job_name: 'sync_repository' } & GithubSyncRepositoryJobData)
  | ({ job_name: 'webhook_event' } & GithubWebhookJobData);
