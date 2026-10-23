export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export interface PublicUser {
  id: string;
  email: string | null;
  displayName: string;
  isGuest: boolean;
  role: 'player' | 'admin';
  chips: number;
  avatarSeed: string;
  /** Google profile photo, if any. */
  avatarUrl: string | null;
  hasGoogle: boolean;
  createdAt: string;
  /** A Google player who hasn't agreed to the friendly-game waiver yet — see pages/Waiver.tsx. */
  needsWaiver: boolean;
}

/** A signed-in player who isn't the admin plays only at their own practice table, against computer players. */
export function isPracticeOnly(user: PublicUser): boolean {
  return !user.isGuest && user.role !== 'admin';
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

/** A guest session exists only to redeem an owner's invite, so it takes the invite's token. */
export function signupGuest(displayName: string, inviteToken: string): Promise<AuthResponse> {
  return postJson('/auth/guest', { displayName, inviteToken });
}

/** Email/password login — only ever reachable by the admin/owner account. See Login.tsx. */
export function login(email: string, password: string): Promise<AuthResponse> {
  return postJson('/auth/login', { email, password });
}

/** `signupKey` is an owner-generated access key — needed only to register a new account (which uses it up), never to sign back in. */
export function googleSignIn(idToken: string, signupKey?: string): Promise<AuthResponse> {
  return postJson('/auth/google', signupKey ? { idToken, signupKey } : { idToken });
}

/** Checks an owner-generated access key before the landing page offers Google sign-up (doesn't use it up). */
export function checkSignupKey(key: string): Promise<{ ok: true }> {
  return postJson('/auth/signup-key', { key });
}

/** Which table an owner's invite code (the `assign` token from an invite link) is for. */
export function lookupInvite(token: string): Promise<{ tableId: string }> {
  return fetch(`${API_BASE}/invites/${encodeURIComponent(token)}`).then((res) => parseOrThrow<{ tableId: string }>(res));
}

/**
 * Local development only: signs in exactly as a verified Google account
 * with this email would, through a route the server only has when
 * ALLOW_TEST_SEEDING=true — see apps/server's testSeed.ts. Lets the
 * player flow be tried without a Google OAuth client.
 */
export function devGoogleSignIn(email: string, displayName: string, signupKey?: string): Promise<AuthResponse> {
  return postJson('/test-only/google-login', signupKey ? { email, displayName, signupKey } : { email, displayName });
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

export interface WaiverDevice {
  platform?: string | undefined;
  language?: string | undefined;
  timeZone?: string | undefined;
  screen?: string | undefined;
  touch?: boolean | undefined;
}

/** Signs the friendly-game waiver: initials, the drawn signature (PNG data URL), the version read, and the device. */
export function acceptWaiver(input: { initials: string; signature: string; version: number; device: WaiverDevice }, accessToken: string): Promise<{ user: PublicUser }> {
  return postJson('/users/me/waiver', input, accessToken);
}

export interface SignedWaiverDto {
  id: string;
  displayName: string;
  email: string | null;
  version: number;
  initials: string;
  signedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  pdfSha256: string;
  accountDeleted: boolean;
}

/** Owner-only: every signed waiver ever, newest first — kept even after an account is deleted. */
export function adminListWaivers(accessToken: string): Promise<{ waivers: SignedWaiverDto[] }> {
  return getJson('/admin/waivers', accessToken);
}

/** Owner-only: fetches a signed waiver's PDF or authorization record as a Blob, with the server's filename. */
export async function adminWaiverFile(id: string, kind: 'pdf' | 'record', accessToken: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_BASE}/admin/waivers/${encodeURIComponent(id)}/${kind}`, { headers: authHeaders(accessToken), credentials: 'include' });
  if (!res.ok) {
    await parseOrThrow(res);
    throw new ApiError({ code: 'DOWNLOAD_FAILED', message: 'Download failed.' });
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `waiver.${kind === 'pdf' ? 'pdf' : 'json'}`;
  return { blob: await res.blob(), filename };
}

export function getMe(accessToken: string): Promise<{ user: PublicUser }> {
  return getJson('/auth/me', accessToken);
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

/** For a practice-only player, `tables` is always empty and `practiceTableId` is their open practice table, if any. */
export function listTables(accessToken: string | null): Promise<{ tables: TableSummaryDto[]; practiceTableId: string | null }> {
  return fetch(`${API_BASE}/tables`, { headers: authHeaders(accessToken ?? undefined) }).then((res) =>
    parseOrThrow<{ tables: TableSummaryDto[]; practiceTableId: string | null }>(res),
  );
}

export type PracticeStakes = 'low' | 'medium' | 'high';

/** Mirrors PRACTICE_STAKES in packages/shared/src/schemas.ts (cents) — the server is the one that enforces it. */
export const PRACTICE_STAKES: Record<PracticeStakes, { label: string; minBuyIn: number; maxBuyIn: number }> = {
  low: { label: '$0.50/$1', minBuyIn: 4_000, maxBuyIn: 10_000 },
  medium: { label: '$1/$2', minBuyIn: 8_000, maxBuyIn: 20_000 },
  high: { label: '$5/$10', minBuyIn: 40_000, maxBuyIn: 100_000 },
};

export function createPracticeTable(input: { bots: number; stakes: PracticeStakes; buyIn: number }, accessToken: string): Promise<{ tableId: string }> {
  return postJson('/tables/practice', input, accessToken);
}

/** Amounts are integer cents — see packages/shared/src/money.ts. */
export interface CreateTableInput {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  isPrivate: boolean;
  minBuyIn?: number;
  maxBuyIn?: number;
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
  reason: 'buy_in' | 'cash_out' | 'pot_win' | 'rake' | 'admin_adjust' | 'welcome_bonus' | 'balance_restored';
  tableId: string | null;
  createdAt: string;
}

export interface MyProfileDto {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  signInMethod: 'google' | 'guest' | 'password';
  createdAt: string;
  lastLoginAt: string | null;
}

export function getMyProfile(accessToken: string): Promise<MyProfileDto> {
  return getJson('/users/me/profile', accessToken);
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
  waiver: { version: number; initials: string; acceptedAt: string } | null;
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

export function adminAdjustChips(userId: string, amount: number, reason: string, accessToken: string): Promise<{ ok: true; reason: string; chips: number }> {
  return postJson('/admin/chips', { userId, amount, reason }, accessToken);
}

/** Sets a balance to an exact amount (cents) — ledgered as the difference. */
export function adminSetChips(userId: string, balance: number, reason: string, accessToken: string): Promise<{ ok: true; reason: string; chips: number }> {
  return postJson('/admin/chips/set', { userId, balance, reason }, accessToken);
}

export interface SignupKeyDto {
  id: string;
  /** The key's last 4 characters — the key itself is only ever shown once, when generated. */
  hint: string;
  label: string;
  email: string | null;
  status: 'active' | 'used' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByName: string | null;
}

/** Owner-only: deletes (terminates) a table — everyone seated is refunded, and it's gone for good. */
export function adminDeleteTable(tableId: string, accessToken: string): Promise<{ ok: true }> {
  return deleteJson(`/admin/tables/${encodeURIComponent(tableId)}`, accessToken);
}

export function adminListSignupKeys(accessToken: string): Promise<{ keys: SignupKeyDto[] }> {
  return getJson('/admin/signup-keys', accessToken);
}

/** Returns the new key itself — the only time it's ever available. */
export function adminCreateSignupKey(
  input: { label: string; email?: string; expiresInDays: number },
  accessToken: string,
): Promise<{ key: string; id: string; expiresAt: string }> {
  return postJson('/admin/signup-keys', input, accessToken);
}

export function adminRevokeSignupKey(id: string, accessToken: string): Promise<{ ok: true }> {
  return deleteJson(`/admin/signup-keys/${encodeURIComponent(id)}`, accessToken);
}

export interface GameReportSummaryDto {
  id: string;
  tableId: string;
  tableName: string;
  status: 'live' | 'final';
  handsPlayed: number;
  lastHandNumber: number | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Headline numbers in cents and the standings; null only for a very old report the server hasn't backfilled. */
  summary: {
    gameNumber: number;
    stakes: string;
    playerCount: number;
    totalBoughtIn: number;
    totalCashedOut: number;
    stillOnTable: number;
    booksBalance: boolean;
    players: {
      rank: number;
      playerName: string;
      playerType: 'registered' | 'guest' | 'bot';
      boughtIn: number;
      net: number;
    }[];
  } | null;
}

/** Admin-only: every game's books, most recently started first. */
export function adminListGameReports(accessToken: string): Promise<{ reports: GameReportSummaryDto[] }> {
  return getJson('/admin/reports', accessToken);
}

/**
 * Admin-only: downloads a game report (YAML or PDF) and saves it under the
 * server's filename (table, game, hand number and time). `path` is either
 * a table's current game (`/admin/tables/:id/report`) or a stored one
 * (`/admin/reports/:id`). Returns the filename saved.
 */
export async function downloadGameReport(path: string, format: 'yaml' | 'pdf', accessToken: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}?format=${format}`, { headers: authHeaders(accessToken), credentials: 'include' });
  if (!res.ok) {
    await parseOrThrow(res); // always throws for a non-OK response, with the server's own message
    throw new ApiError({ code: 'DOWNLOAD_FAILED', message: 'Download failed.' });
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `game-report.${format}`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}
