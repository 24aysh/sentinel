const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RequestContext {
  requestId: string;
  startedAt: number;
  model: string;
}

export function resolveRequestId(candidate?: string | null): string {
  if (candidate && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  return crypto.randomUUID();
}

export function createRequestContext(
  requestId: string,
  model: string,
  startedAt = Date.now(),
): RequestContext {
  return { requestId, startedAt, model };
}
