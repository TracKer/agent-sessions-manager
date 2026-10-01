export function isoToEpochMs(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

export function epochMsToIso(value: number): string {
  return new Date(value).toISOString();
}
