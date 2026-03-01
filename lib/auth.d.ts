export interface AuthResult {
  authenticated: boolean;
  userId: string | null;
  claims: Record<string, unknown> | null;
  error: string | null;
}

export interface AuthConfig {
  mode?: 'trust' | 'verify';
  signingKey?: string;
  claimsPath?: string;
}

export interface Authenticator {
  authenticate(req: object): AuthResult;
}

export function createAuth(authConfig?: AuthConfig): Authenticator;

export interface AdminAuthResult {
  authenticated: boolean;
  error: string | null;
}

export function authenticateAdmin(req: object, adminKey: string): AdminAuthResult;
