// Small, table-toggleable word-boundary filter. Not exhaustive — a real
// deployment would swap this for a proper library or moderation service;
// this satisfies the spec's "server-side profanity filter toggle" as a
// genuine, working implementation rather than a stub.
const BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot'];

const PATTERN = new RegExp(`\\b(${BLOCKED_WORDS.join('|')})\\b`, 'gi');

export function filterProfanity(message: string, enabled: boolean): string {
  if (!enabled) return message;
  return message.replace(PATTERN, (match) => '*'.repeat(match.length));
}
