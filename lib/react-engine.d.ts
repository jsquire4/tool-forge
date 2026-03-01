export type ReactEventType =
  | 'text'
  | 'text_delta'
  | 'tool_call'
  | 'tool_result'
  | 'tool_warning'
  | 'hitl'
  | 'error'
  | 'done';

export interface TextEvent {
  type: 'text';
  content: string;
}

export interface TextDeltaEvent {
  type: 'text_delta';
  content: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  id: string;
  tool?: string;
  result: unknown;
}

export interface ToolWarningEvent {
  type: 'tool_warning';
  tool: string;
  message: string;
  verifier?: string;
}

export interface HitlEvent {
  type: 'hitl';
  tool?: string;
  message?: string;
  resumeToken?: string;
  verifier?: string;
  conversationMessages?: unknown[];
  pendingToolCalls?: unknown[];
  turnIndex?: number;
  args?: Record<string, unknown>;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export interface DoneEvent {
  type: 'done';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    [key: string]: unknown;
  };
}

export type ReactEvent =
  | TextEvent
  | TextDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolWarningEvent
  | HitlEvent
  | ErrorEvent
  | DoneEvent;

export interface ReactMessage {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
}

export interface ReactLoopParams {
  provider: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ReactMessage[];
  tools?: unknown[];
  maxTurns?: number;
  maxTokens?: number;
  forgeConfig?: object;
  db?: object | null;
  userJwt?: string | null;
  stream?: boolean;
  hooks?: {
    shouldPause?: (toolMeta: object) => { pause: boolean; message?: string };
    onAfterToolCall?: (toolName: string, args: object, result: unknown) => Promise<{ outcome: 'pass' | 'warn' | 'block'; message?: string | null; verifierName?: string }>;
  };
}

export function reactLoop(params: ReactLoopParams): AsyncIterable<ReactEvent>;

export function executeToolCall(
  toolName: string,
  args: object,
  forgeConfig: object,
  db: object | null,
  userJwt: string | null
): Promise<{ status: number; body: object; error: string | null }>;
