/**
 * Slack Crawler Signal Heuristics & Thread Evaluator
 * 
 * Evaluates whether a Slack conversation thread constitutes a candidate SOP
 * relying on explicit text patterns and reply activity instead of fragile emoji reactions.
 */

export interface SlackMessage {
  user: string;
  text: string;
  ts?: string;
  reply_count?: number;
}

export interface SlackThread {
  thread_ts: string;
  channel: string;
  reply_count: number;
  messages: SlackMessage[];
}

/**
 * Text pattern heuristics for high-value operational procedures, post-mortems, and runbooks
 */
const SOP_SIGNAL_PATTERNS = [
  /resolution:/i,
  /mitigation:/i,
  /root\s*cause:/i,
  /\[P0\]/i,
  /\[P1\]/i,
  /sop:/i,
  /procedure:/i,
  /runbook:/i,
  /workaround:/i,
  /incident\s*override/i,
];

/**
 * Evaluates a Slack thread to determine if it is a candidate SOP.
 * 
 * Heuristics:
 * 1. Thread reply count must be > 2 (indicates multi-step, active problem solving).
 * 2. Thread text content must match explicit operational signal patterns ('resolution:', 'mitigation:', '[P0]', '[P1]', etc.).
 */
export function isSOPCandidateSlackThread(thread: SlackThread): boolean {
  const totalReplies = thread.reply_count || thread.messages?.length || 0;
  if (totalReplies <= 2) {
    return false;
  }

  const fullText = (thread.messages || []).map((m) => m.text || '').join(' ');
  return SOP_SIGNAL_PATTERNS.some((pattern) => pattern.test(fullText));
}

/**
 * Filters a collection of Slack threads down to high-confidence SOP candidates.
 */
export async function processSlackThreadCandidates(threads: SlackThread[]): Promise<SlackThread[]> {
  return threads.filter(isSOPCandidateSlackThread);
}
