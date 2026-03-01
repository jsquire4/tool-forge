export interface ConversationMessage {
  session_id?: string;
  stage?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  agent_id?: string | null;
  user_id?: string | null;
  created_at?: string;
}

export interface SessionSummary {
  sessionId: string;
  agentId: string | null;
  userId: string | null;
  startedAt: string;
  lastUpdated: string;
}

export interface ConversationStore {
  createSession(): string;
  persistMessage(
    sessionId: string,
    stage: string,
    role: string,
    content: string,
    agentId?: string | null,
    userId?: string | null
  ): Promise<void>;
  getHistory(sessionId: string): Promise<ConversationMessage[]>;
  getIncompleteSessions(): Promise<object[]>;
  getSessionUserId(sessionId: string): Promise<string | null | undefined>;
  listSessions(userId: string | null): Promise<SessionSummary[]>;
  deleteSession(sessionId: string, userId: string | null): Promise<boolean>;
  close(): Promise<void>;
}

export class SqliteConversationStore implements ConversationStore {
  constructor(db: object);
  createSession(): string;
  persistMessage(sessionId: string, stage: string, role: string, content: string, agentId?: string | null, userId?: string | null): Promise<void>;
  getHistory(sessionId: string): Promise<ConversationMessage[]>;
  getIncompleteSessions(): Promise<object[]>;
  getSessionUserId(sessionId: string): Promise<string | null | undefined>;
  listSessions(userId: string | null): Promise<SessionSummary[]>;
  deleteSession(sessionId: string, userId: string | null): Promise<boolean>;
  close(): Promise<void>;
}

export class RedisConversationStore implements ConversationStore {
  constructor(redisConfig?: { url?: string; ttlSeconds?: number });
  createSession(): string;
  persistMessage(sessionId: string, stage: string, role: string, content: string, agentId?: string | null, userId?: string | null): Promise<void>;
  getHistory(sessionId: string): Promise<ConversationMessage[]>;
  getIncompleteSessions(): Promise<object[]>;
  getSessionUserId(sessionId: string): Promise<string | null | undefined>;
  listSessions(userId: string | null): Promise<SessionSummary[]>;
  deleteSession(sessionId: string, userId: string | null): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresConversationStore implements ConversationStore {
  constructor(pgPool: object);
  createSession(): string;
  persistMessage(sessionId: string, stage: string, role: string, content: string, agentId?: string | null, userId?: string | null): Promise<void>;
  getHistory(sessionId: string): Promise<ConversationMessage[]>;
  getIncompleteSessions(): Promise<object[]>;
  getSessionUserId(sessionId: string): Promise<string | null | undefined>;
  listSessions(userId: string | null): Promise<SessionSummary[]>;
  deleteSession(sessionId: string, userId: string | null): Promise<boolean>;
  close(): Promise<void>;
}

export function makeConversationStore(
  config: object,
  db?: object | null,
  pgPool?: object | null
): SqliteConversationStore | RedisConversationStore | PostgresConversationStore;
