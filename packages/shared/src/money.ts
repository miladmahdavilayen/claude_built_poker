/**
 * Every chip amount everywhere — engine, server, database, wire — is an
 * integer number of CENTS. Integers keep pot/side-pot/odd-chip math exact
 * (no floating-point drift); cents are what make sub-dollar stakes like
 * $0.10/$0.20 representable at all. Only the UI ever converts to dollars,
 * for display and for input. See DECISIONS.md.
 */
export const CENTS_PER_DOLLAR = 100;

/** "$1,250", "$0.10", "$2.50", "-$5" — cents only shown when there are any. */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / CENTS_PER_DOLLAR).toLocaleString('en-US');
  const rem = abs % CENTS_PER_DOLLAR;
  return rem === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rem).padStart(2, '0')}`;
}

/** A dollar amount typed by a person (e.g. 0.1, 2.5, 100) to integer cents. Rounds to the nearest cent. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

/** Integer cents to a plain dollar number for an input field (e.g. 10 -> 0.1, 250 -> 2.5). */
export function centsToDollars(cents: number): number {
  return cents / CENTS_PER_DOLLAR;
}
