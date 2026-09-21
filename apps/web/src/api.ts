export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export interface PublicUser {
  id: string;
  email: string | null;
  displayName: string;
  isGuest: boolean;
  role: 'player' | 'admin';
  chips: number;
  avatarSeed: string;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  constructor(body: ApiErrorBody) {
    super(body.message);
    this.code = body.code;
  }
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      throw new ApiError(body as ApiErrorBody);
    }
    throw new ApiError({ code: 'UNKNOWN_ERROR', message: `Request failed (${String(res.status)})` });
  }
  return body as T;
}

function postJson<T>(path: string, payload: unknown, accessToken?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(payload),
  }).then((res) => parseOrThrow<T>(res));
}

export function signupGuest(displayName: string): Promise<AuthResponse> {
  return postJson('/auth/guest', { displayName });
}

export function register(email: string, password: string, displayName: string): Promise<AuthResponse> {
  return postJson('/auth/register', { email, password, displayName });
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return postJson('/auth/login', { email, password });
}

export function upgrade(email: string, password: string, accessToken: string): Promise<AuthResponse> {
  return postJson('/auth/upgrade', { email, password }, accessToken);
}

export function googleSignIn(idToken: string): Promise<AuthResponse> {
  return postJson('/auth/google', { idToken });
}

export function upgradeWithGoogle(idToken: string, accessToken: string): Promise<AuthResponse> {
  return postJson('/auth/upgrade/google', { idToken }, accessToken);
}

export function googleSignInAvailable(): Promise<boolean> {
  return fetch(`${API_BASE}/auth/google/available`)
    .then((res) => parseOrThrow<{ available: boolean }>(res))
    .then((body) => body.available)
    .catch(() => false);
}

export function refresh(): Promise<AuthResponse> {
  return fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' }).then((res) => parseOrThrow<AuthResponse>(res));
}

export function logout(): Promise<{ ok: true }> {
  return fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).then((res) => parseOrThrow<{ ok: true }>(res));
}

export interface TableSummaryDto {
  tableId: string;
  name: string;
  settings: {
    smallBlind: number;
    bigBlind: number;
    maxSeats: number;
    minBuyIn: number;
    maxBuyIn: number;
    isPrivate: boolean;
  };
  seatsFilled: number;
  maxSeats: number;
  isPrivate: boolean;
}

export function listTables(): Promise<{ tables: TableSummaryDto[] }> {
  return fetch(`${API_BASE}/tables`).then((res) => parseOrThrow<{ tables: TableSummaryDto[] }>(res));
}

export interface CreateTableInput {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  isPrivate: boolean;
}

export function createTable(
  input: CreateTableInput,
  accessToken: string,
): Promise<{ tableId: string; name: string; inviteCode: string | null }> {
  return postJson('/tables', input, accessToken);
}
