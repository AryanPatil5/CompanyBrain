/**
 * Temporal Validity & Time-Decay Graph Service
 * Filters out expired edges and applies exponential decay scoring to knowledge graph relationships.
 */

export function isEdgeTemporallyValid(
  validFrom?: string | Date | null,
  validUntil?: string | Date | null,
  referenceDate: Date = new Date()
): boolean {
  const refTime = referenceDate.getTime();

  if (validFrom) {
    const fromTime = new Date(validFrom).getTime();
    if (refTime < fromTime) return false;
  }

  if (validUntil) {
    const untilTime = new Date(validUntil).getTime();
    if (refTime > untilTime) return false; // Edge has expired
  }

  return true;
}

export function calculateTemporalDecayScore(
  createdAt: string | Date,
  halfLifeDays: number = 30
): number {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const ageInDays = Math.max(0, (now - created) / (1000 * 60 * 60 * 24));

  const lambda = Math.LN2 / halfLifeDays;
  const score = Math.exp(-lambda * ageInDays);

  return Math.max(0.01, Math.min(1.0, score));
}

export function filterActiveEdges<T extends { valid_from?: string | Date | null; valid_until?: string | Date | null }>(
  edges: T[],
  referenceDate: Date = new Date()
): T[] {
  return edges.filter((e) => isEdgeTemporallyValid(e.valid_from, e.valid_until, referenceDate));
}
