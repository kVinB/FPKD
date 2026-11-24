export interface ApiField {
  field: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: ApiField[];
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: ApiField[] = [],
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
}

async function parseError(response: Response): Promise<ApiError> {
  let payload: {
    error?: { code?: string; message?: string; fields?: ApiField[]; details?: Record<string, unknown> };
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }
  return new ApiError(
    response.status,
    payload.error?.code ?? 'request_failed',
    payload.error?.message ?? 'The request could not be completed.',
    payload.error?.fields ?? [],
    payload.error?.details,
  );
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'network',
      'Not saved. Connect to your home network or WireGuard and retry.',
    );
  }

  if (!response.ok) {
    const error = await parseError(response);
    if (
      response.status === 401 &&
      !path.startsWith('/auth/login') &&
      !path.startsWith('/auth/session') &&
      !path.startsWith('/auth/csrf')
    ) {
      window.dispatchEvent(new CustomEvent('sd:auth-lost'));
    }
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function downloadFile(
  path: string,
  fallbackName: string,
): Promise<{ filename: string; blob: Blob }> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(
      0,
      'network',
      'Not downloaded. Connect to your home network or WireGuard and retry.',
    );
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return { filename, blob };
}

export async function bootstrapLoginCsrf(): Promise<string> {
  const data = await api<{ csrfToken: string }>('/auth/csrf');
  return data.csrfToken;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export function errorFieldMap(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const map: Record<string, string> = {};
  for (const field of error.fields) {
    if (!map[field.field]) map[field.field] = field.message;
  }
  return map;
}
