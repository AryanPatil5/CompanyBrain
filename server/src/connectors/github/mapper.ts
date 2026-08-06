import type { GitHubDocumentType } from './types.js';

// Directories that are never indexed (build artifacts, vendored code, VCS internals).
const IGNORED_DIRECTORY_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'vendor',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.idea',
  '.vscode',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  'DerivedData',
  '.terraform',
  'tmp',
  'logs',
  'public/vendor',
]);

// Binary / non-text extensions that are never fetched as document text.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'avif', 'heic',
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'mpg', 'mpeg', 'm4v',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst',
  'jar', 'war', 'ear', 'apk', 'ipa', 'exe', 'msi', 'dll', 'so', 'dylib', 'a', 'o', 'obj',
  'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'class', 'pyc', 'pyo', 'whl', 'deb', 'rpm',
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp', 'epub', 'mobi',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
]);

// Text extensions that are eligible for code / documentation indexing.
const TEXT_EXTENSIONS = new Set([
  // Code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'java', 'rs', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs',
  'php', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'prisma', 'vue', 'svelte', 'astro', 'lua', 'pl', 'r', 'dart',
  'elm', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'nim', 'zig', 'cob', 'asm', 'fs', 'fsx', 'sol',
  'tf', 'hcl', 'dockerfile',
  // Config / data (text)
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'xml', 'csv', 'tsv',
  // Docs
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'html', 'htm', 'css', 'scss', 'sass', 'less',
]);

// File names (any casing) always treated as indexable text regardless of extension.
const NAMED_TEXT_FILES = new Set(['dockerfile', 'makefile', 'license', 'licence', 'copying', 'readme', 'changelog', 'changelog.md']);

// Lockfiles / generated manifests that add noise without knowledge value.
const IGNORED_FILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'cargo.lock', 'go.sum', 'gemfile.lock', 'composer.lock', 'pdm.lock', 'uv.lock',
  'pipfile.lock', 'flake.lock', 'bun.lockb', 'bun.lock', 'deno.lock',
]);

function getExtension(path: string): string {
  const lastSegment = path.split('/').pop() || '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

function getFileName(path: string): string {
  const lastSegment = path.split('/').pop() || '';
  return lastSegment.toLowerCase();
}

export function isIgnoredPath(path: string): boolean {
  if (!path) return true;
  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRECTORY_SEGMENTS.has(segments[i])) return true;
  }
  const fileName = getFileName(path);
  if (IGNORED_FILE_NAMES.has(fileName)) return true;
  const ext = getExtension(path);
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (TEXT_EXTENSIONS.has(ext)) return false;
  return !NAMED_TEXT_FILES.has(fileName);
}

export function isReadmePath(path: string): boolean {
  return /^readme(\.[a-z0-9]+)?$/i.test(getFileName(path));
}

export function documentTypeFromPath(path: string): GitHubDocumentType {
  return isReadmePath(path) ? 'readme' : 'file';
}

export function splitFullName(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split('/');
  return { owner: owner || fullName, name: name || '' };
}

export interface GithubDocumentPayload {
  workspaceId: string;
  repositoryId: string;
  repositoryName: string;
  branch: string;
  commit: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  permissions: Record<string, boolean>;
  source: 'github';
  type: GitHubDocumentType;
  externalId: string;
  title: string;
  text: string;
  path: string;
}

interface FileMappingInput {
  workspaceId: string;
  repoId: number;
  fullName: string;
  branch: string;
  commit: string;
  commitDate?: string;
  path: string;
  sha: string;
  content: string;
  url: string;
  permissions: Record<string, boolean>;
}

export function mapRepoFile(input: FileMappingInput): GithubDocumentPayload {
  const type = documentTypeFromPath(input.path);
  return {
    workspaceId: input.workspaceId,
    repositoryId: String(input.repoId),
    repositoryName: input.fullName,
    branch: input.branch,
    commit: input.commit,
    author: 'github-bot',
    url: input.url,
    createdAt: input.commitDate || '',
    updatedAt: input.commitDate || '',
    permissions: input.permissions,
    source: 'github',
    type,
    externalId: `${input.fullName}/${type}/${input.path}`,
    title: input.path,
    text: input.content,
    path: input.path,
  };
}

interface IssueLikeMappingInput {
  workspaceId: string;
  repoId: number;
  fullName: string;
  branch: string;
  commit: string;
  kind: 'issue' | 'pull_request' | 'release';
  numberOrTag: string | number;
  title: string;
  body: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  permissions: Record<string, boolean>;
  metadata?: Record<string, any>;
}

export function mapIssueLike(input: IssueLikeMappingInput): GithubDocumentPayload {
  return {
    workspaceId: input.workspaceId,
    repositoryId: String(input.repoId),
    repositoryName: input.fullName,
    branch: input.branch,
    commit: input.commit,
    author: input.author || 'unknown',
    url: input.url,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    permissions: input.permissions,
    source: 'github',
    type: input.kind,
    externalId: `${input.fullName}/${input.kind}/${input.numberOrTag}`,
    title: input.title,
    text: input.body ? `${input.title}\n\n${input.body}` : input.title,
    path: `${input.kind}/${input.numberOrTag}`,
  };
}

interface DiscussionMappingInput {
  workspaceId: string;
  repoId: number;
  fullName: string;
  branch: string;
  commit: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  category: string;
  permissions: Record<string, boolean>;
}

export function mapDiscussion(input: DiscussionMappingInput): GithubDocumentPayload {
  return {
    workspaceId: input.workspaceId,
    repositoryId: String(input.repoId),
    repositoryName: input.fullName,
    branch: input.branch,
    commit: input.commit,
    author: input.author || 'unknown',
    url: input.url,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    permissions: input.permissions,
    source: 'github',
    type: 'discussion',
    externalId: `${input.fullName}/discussion/${input.number}`,
    title: input.title,
    text: input.body ? `${input.title}\n\n${input.body}` : input.title,
    path: `discussion/${input.number}`,
  };
}

interface WikiMappingInput {
  workspaceId: string;
  repoId: number;
  fullName: string;
  branch: string;
  commit: string;
  commitDate?: string;
  path: string;
  content: string;
  permissions: Record<string, boolean>;
}

export function mapWikiPage(input: WikiMappingInput): GithubDocumentPayload {
  return {
    workspaceId: input.workspaceId,
    repositoryId: String(input.repoId),
    repositoryName: input.fullName,
    branch: input.branch,
    commit: input.commit,
    author: 'github-bot',
    url: `https://github.com/${input.fullName}/wiki/${input.path.replace(/\.(md|txt)$/i, '')}`,
    createdAt: input.commitDate || '',
    updatedAt: input.commitDate || '',
    permissions: input.permissions,
    source: 'github',
    type: 'wiki',
    externalId: `${input.fullName}/wiki/${input.path}`,
    title: input.path,
    text: input.content,
    path: `wiki/${input.path}`,
  };
}
