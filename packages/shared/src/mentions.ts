/** The names a chat message mentions (`@Name`), longest first so "@Ann Lee" isn't taken for "@Ann". Case doesn't matter. */
export function mentionedNames(message: string, names: readonly string[]): string[] {
  const text = message.toLowerCase();
  const found: string[] = [];
  let rest = text;
  for (const name of [...new Set(names)].filter((n) => n.trim().length > 0).sort((a, b) => b.length - a.length)) {
    const needle = `@${name.toLowerCase()}`;
    if (!rest.includes(needle)) continue;
    found.push(name);
    rest = rest.split(needle).join(' ');
  }
  return found;
}
