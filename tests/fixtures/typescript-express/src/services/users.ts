export interface User {
  id: string;
  active: boolean;
}

const TOKENS: Record<string, User> = {
  "token-ada": { id: "ada", active: true },
  "token-bob": { id: "bob", active: false },
};

export async function findUserByToken(token: string): Promise<User | null> {
  const user = TOKENS[token];
  return user && user.active ? user : null;
}
