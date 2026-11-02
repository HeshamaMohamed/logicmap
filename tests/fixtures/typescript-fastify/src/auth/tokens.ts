const TOKENS: Record<string, string> = { "token-ada": "ada" };

export function verifyToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return TOKENS[header.slice(7)] ?? null;
}
