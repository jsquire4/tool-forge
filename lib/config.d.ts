export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
}

export interface VerificationConfig {
  sandbox: boolean;
  workerPoolSize: number | null;
  customTimeout: number;
  maxQueueDepth: number;
}

export interface ConversationConfig {
  store?: string;
  window: number;
  redis?: object;
}

export interface DatabaseConfig {
  type?: 'sqlite' | 'postgres';
  url?: string;
}

export interface AuthConfig {
  mode?: 'trust' | 'verify';
  signingKey?: string;
  claimsPath?: string;
}

export interface AgentConfig {
  id?: string;
  displayName?: string;
  systemPrompt?: string;
  defaultModel?: string;
  defaultHitlLevel?: string;
  toolAllowlist?: string | string[];
  maxTurns?: number;
  maxTokens?: number;
  isDefault?: number;
  enabled?: number;
}

export interface SidecarConfig {
  auth?: AuthConfig;
  defaultModel?: string;
  defaultHitlLevel?: 'autonomous' | 'cautious' | 'standard' | 'paranoid';
  allowUserModelSelect?: boolean;
  allowUserHitlConfig?: boolean;
  systemPrompt?: string;
  adminKey?: string;
  conversation?: ConversationConfig;
  rateLimit?: RateLimitConfig;
  verification?: VerificationConfig;
  database?: DatabaseConfig;
  sidecar?: { enabled?: boolean; port?: number };
  agents?: AgentConfig[];
  costs?: Record<string, { input: number; output: number }>;
}

export const CONFIG_DEFAULTS: SidecarConfig;

export function mergeDefaults(config: Partial<SidecarConfig>): SidecarConfig;
export function validateConfig(config: SidecarConfig): { valid: boolean; errors: string[] };
