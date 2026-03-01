import type { Server } from 'http';
import type { SidecarConfig } from './config-schema.js';
import type { AuthResult, AuthConfig, Authenticator } from './auth.js';
import type { ConversationMessage, SessionSummary, ConversationStore } from './conversation-store.js';
import type { ReactEvent, ReactLoopParams } from './react-engine.js';

export interface SidecarOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  env?: Record<string, string>;
  autoListen?: boolean;
  enableDrift?: boolean;
  widgetDir?: string;
}

export interface SidecarContext {
  auth: Authenticator;
  promptStore: object;
  preferenceStore: object;
  conversationStore: ConversationStore;
  agentRegistry: object;
  verifierRunner: object | null;
  hitlEngine: object | null;
  rateLimiter: object | null;
  db: object;
  config: SidecarConfig;
  env: Record<string, string>;
  configPath?: string;
  [key: string]: unknown;
}

export interface SidecarInstance {
  server: Server;
  ctx: SidecarContext;
  close(): Promise<void>;
}

export function createSidecar(config?: Partial<SidecarConfig>, options?: SidecarOptions): Promise<SidecarInstance>;

// Advanced consumers
export function buildSidecarContext(config: SidecarConfig, db: object, env?: Record<string, string>, opts?: object): Promise<SidecarContext>;
export function createSidecarRouter(ctx: SidecarContext, opts?: object): (req: object, res: object) => void;

export { createAuth } from './auth.js';
export type { AuthResult, AuthConfig, Authenticator } from './auth.js';

export { reactLoop } from './react-engine.js';
export type { ReactEvent, ReactLoopParams, TextEvent, TextDeltaEvent, ToolCallEvent, ToolResultEvent, ToolWarningEvent, HitlEvent, ErrorEvent, DoneEvent } from './react-engine.js';

export { mergeDefaults, validateConfig, CONFIG_DEFAULTS } from './config-schema.js';
export type { SidecarConfig, AgentConfig, RateLimitConfig, VerificationConfig } from './config-schema.js';

export { makeConversationStore } from './conversation-store.js';
export type { ConversationMessage, SessionSummary, ConversationStore } from './conversation-store.js';

export function getDb(path: string): object;
export function initSSE(res: object): { write(event: string, data: unknown): void; close(): void };
export function makePromptStore(config: object, db: object): object;
export function makePreferenceStore(config: object, db: object): object;
export function makeHitlEngine(config: object, db: object, redis?: object, pgPool?: object): object;
export function makeAgentRegistry(config: object, db: object): object;

export class AgentRegistry {
  constructor(config: object, db: object);
  resolveAgent(agentId: string | null): Promise<object | null>;
  getAgent(agentId: string): Promise<object | null>;
  getAllAgents(): Promise<object[]>;
  upsertAgent(agent: object): Promise<void>;
  setDefault(agentId: string): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  seedFromConfig(): Promise<void>;
  filterTools(tools: object[]): object[];
  buildAgentConfig(config: object, agent: object | null): object;
  resolveSystemPrompt(agent: object | null, promptStore: object, config: object): Promise<string>;
}

export class VerifierRunner {
  constructor(db: object, config?: object, workerPool?: object);
  loadFromDb(db: object): Promise<void>;
  run(toolName: string, args: object, result: unknown): Promise<Array<{ outcome: 'pass' | 'warn' | 'block'; message: string | null; verifier: string }>>;
  destroy(): void;
}
