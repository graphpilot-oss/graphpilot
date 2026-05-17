export function parseToken(token: string): string {
  return token.trim();
}

export const validateJwt = (jwt: string): boolean => {
  return jwt.length > 0;
};

const internalHelper = function (x: number) {
  return x * 2;
};

export class AuthService {
  authenticate(user: string): boolean {
    return parseToken(user).length > 0;
  }

  private async fetchUser(id: string): Promise<string> {
    return id;
  }
}

export interface Repository {
  save(): void;
}

export type UserId = string;

enum Role {
  Admin,
  Member,
}
