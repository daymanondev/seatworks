/** Text from outside the team, fenced so it cannot speak as the desk: the words inside must not be able to close the fence. */
export function outside(tag: string, text: string, limit: number): string {
  // One pass, cutting a fence as its last character arrives: a removal can join a new fence, and repeated sweeps go quadratic.
  const open = `<${tag}>`.toLowerCase();
  const close = `</${tag}>`.toLowerCase();
  const kept: string[] = [];
  const ends = (token: string) => {
    if (kept.length < token.length) return false;
    for (let at = 0; at < token.length; at++) if (kept[kept.length - token.length + at]!.toLowerCase() !== token[at]) return false;
    return true;
  };
  for (let at = 0; at < text.length; at++) {
    kept.push(text[at]!);
    const fence = ends(close) ? close : ends(open) ? open : undefined;
    if (fence) kept.length -= fence.length;
  }
  return clip(kept.join(""), limit);
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n[… ${text.length - limit} more characters]`;
}
