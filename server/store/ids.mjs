// server/store/ids.mjs — what a record id and a file token may look like.
//
// Shared by both stores. Anything else is refused before it can become part
// of a path or a blob name, so a crafted id ("../../x") never resolves.

export const ID_PATTERN = /^(res|run)_[A-Za-z0-9]{16,64}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function checked(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${what}`);
  return value;
}
