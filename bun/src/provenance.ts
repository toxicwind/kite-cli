// provenance — unreliable-narrator filter (argon PoC, proven on the fleet 2026-10-28):
// a dated OUTLET is required; aggregators and bare schemes are poison by default.
export function isUnreliable(source: string): boolean {
  return /adminremix|aggregator/i.test(source) || !/20\d\d/.test(source) || /^[a-z]+:\/\//i.test(source.trim());
}

export interface Source { outlet: string; errorRate: number; text?: string }
export function unpoison<T extends Source>(sources: T[]): T[] {
  return sources.filter((s) => !isUnreliable(s.outlet) && s.errorRate < 0.1);
}
