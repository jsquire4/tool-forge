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
  mode?: 'trust' | 'verify' | 'none';
  signingKey?: string | null;
  claimsPath?: string;
  /** Admin Bearer token. Replaces top-level `adminKey`. Supports `${VAR}` env references. */
  adminToken?: string | null;
  /** Metrics scrape token for /metrics. Supports `${VAR}` env references. */
  metricsToken?: string | null;
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
  /** DB-only — set by agent_registry, not forge.config.json */
  isDefault?: number;
  /** DB-only — set by agent_registry, not forge.config.json */
  enabled?: number;
}

export interface AgentRouterConfig {
  endpoint?: string | null;
  method?: string;
  headers?: Record<string, string>;
  inputField?: string;
  outputField?: string;
  sessionField?: string;
}

export interface GatesConfig {
  passRate?: number | null;
  maxCost?: number | null;
  p95LatencyMs?: number | null;
}

export interface FixturesConfig {
  dir?: string;
  ttlDays?: number;
}

export interface SidecarConfig {
  auth?: AuthConfig;
  defaultModel?: string;
  defaultHitlLevel?: 'autonomous' | 'cautious' | 'standard' | 'paranoid';
  allowUserModelSelect?: boolean;
  allowUserHitlConfig?: boolean;
  systemPrompt?: string;
  /** @deprecated Use `auth.adminToken` instead. */
  adminKey?: string | null;
  conversation?: ConversationConfig;
  rateLimit?: RateLimitConfig;
  verification?: VerificationConfig;
  database?: DatabaseConfig;
  /** `port` is used in direct-run mode only (`node lib/forge-service.js`). `createSidecar()` uses `SidecarOptions.port`. */
  sidecar?: { port?: number };
  agents?: AgentConfig[];
  costs?: Record<string, { input: number; output: number }>;
  agent?: AgentRouterConfig;
  gates?: GatesConfig;
  fixtures?: FixturesConfig;
}

export const CONFIG_DEFAULTS: SidecarConfig;

export function mergeDefaults(config: Partial<SidecarConfig>): SidecarConfig;
export function validateConfig(config: SidecarConfig): { valid: boolean; errors: string[] };
