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

function authHeaders(accessToken?: string): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function postJson<T>(path: string, payload: unknown, accessToken?: string): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    credentials: 'include',
    body: JSON.stringify(payload),
  }).then((res) => parseOrThrow<T>(res));
}

function getJson<T>(path: string, accessToken: string): Promise<T> {
  return fetch(`${API_BASE}${path}`, { headers: authHeaders(accessToken), credentials: 'include' }).then((res) => parseOrThrow<T>(res));
}

function patchJson<T>(path: string, payload: unknown, accessToken: string): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    credentials: 'include',
    body: JSON.stringify(payload),
  }).then((res) => parseOrThrow<T>(res));
}

function deleteJson<T>(path: string, accessToken: string): Promise<T> {
  return fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders(accessToken), credentials: 'include' }).then((res) =>
    parseOrThrow<T>(res),
  );
}

export function signupGuest(displayName: string): Promise<AuthResponse> {
  return postJson('/auth/guest', { displayName });
}

/** Email/password login — only ever reachable by the admin/owner account. See Login.tsx. */
export function login(email: string, password: string): Promise<AuthResponse> {
  return postJson('/auth/login', { email, password });
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

export interface LedgerEntryDto {
  id: string;
  amount: number;
  reason: 'buy_in' | 'cash_out' | 'pot_win' | 'rake' | 'admin_adjust';
  tableId: string | null;
  createdAt: string;
}

export interface MySummaryDto {
  balance: number;
  netPlayResult: number;
  recentEntries: LedgerEntryDto[];
}

export function getMySummary(accessToken: string): Promise<MySummaryDto> {
  return getJson('/users/me/summary', accessToken);
}

export function deleteMyAccount(accessToken: string): Promise<{ ok: true }> {
  return deleteJson('/users/me', accessToken);
}

export interface AdminUserDto {
  id: string;
  displayName: string;
  email: string | null;
  isGuest: boolean;
  role: 'player' | 'admin';
  chips: number;
  hasGoogle: boolean;
  createdAt: string;
}

export interface AdminUserDetailDto extends AdminUserDto {
  netPlayResult: number;
  recentEntries: LedgerEntryDto[];
}

export function adminListUsers(accessToken: string): Promise<{ users: AdminUserDto[] }> {
  return getJson('/admin/users', accessToken);
}

export function adminGetUser(userId: string, accessToken: string): Promise<AdminUserDetailDto> {
  return getJson(`/admin/users/${encodeURIComponent(userId)}`, accessToken);
}

export function adminUpdateUser(userId: string, displayName: string, accessToken: string): Promise<{ id: string; displayName: string }> {
  return patchJson(`/admin/users/${encodeURIComponent(userId)}`, { displayName }, accessToken);
}

export function adminDeleteUser(userId: string, accessToken: string): Promise<{ ok: true }> {
  return deleteJson(`/admin/users/${encodeURIComponent(userId)}`, accessToken);
}

/** The admin's own account (or any id that no longer exists) is silently skipped server-side rather than failing the whole batch — see `skipped` in the response. */
export function adminBulkDeleteUsers(userIds: string[], accessToken: string): Promise<{ ok: true; deleted: string[]; skipped: string[] }> {
  return postJson('/admin/users/bulk-delete', { userIds }, accessToken);
}

export function adminAdjustChips(userId: string, amount: number, reason: string, accessToken: string): Promise<{ ok: true; reason: string }> {
  return postJson('/admin/chips', { userId, amount, reason }, accessToken);
}
