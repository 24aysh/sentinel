import type { ChatRole } from "../../domain/chat.ts";
import type { PromptInjectionMessage } from "./prompt-injection-classifier.ts";

export const PROMPT_INJECTION_MAX_TOKENS = 256;
export const PROMPT_INJECTION_OVERLAP_TOKENS = 64;
export const PROMPT_INJECTION_MAX_WINDOWS = 32;
export const PROMPT_INJECTION_MAX_BATCH_WINDOWS = 8;
export const PROMPT_INJECTION_MAX_SELECTED_CODE_UNITS = 50_000;

const CLS_TOKEN_ID = 101;
const SEP_TOKEN_ID = 102;
const PAD_TOKEN_ID = 0;
const CONTENT_CAPACITY = PROMPT_INJECTION_MAX_TOKENS - 2;
const WINDOW_ADVANCE = CONTENT_CAPACITY - PROMPT_INJECTION_OVERLAP_TOKENS;

export interface PromptInjectionTokenWindow {
  messageIndex: number;
  role: ChatRole;
  inputIds: readonly number[];
  attentionMask: readonly number[];
}

export type PromptInjectionWindowingResult =
  | {
      decision: "ready";
      windows: readonly PromptInjectionTokenWindow[];
      evaluatedMessageCount: number;
    }
  | {
      decision: "limit_exceeded";
      evaluatedMessageCount: number;
      evaluatedWindowCount: number;
    };

function createWindow(
  message: PromptInjectionMessage,
  contentIds: readonly number[],
): PromptInjectionTokenWindow {
  const realIds = [CLS_TOKEN_ID, ...contentIds, SEP_TOKEN_ID];
  const paddingLength = PROMPT_INJECTION_MAX_TOKENS - realIds.length;
  return {
    messageIndex: message.messageIndex,
    role: message.role,
    inputIds: [...realIds, ...Array<number>(paddingLength).fill(PAD_TOKEN_ID)],
    attentionMask: [
      ...Array<number>(realIds.length).fill(1),
      ...Array<number>(paddingLength).fill(0),
    ],
  };
}

export function createPromptInjectionWindows(
  messages: readonly PromptInjectionMessage[],
  encode: (content: string) => readonly number[],
): PromptInjectionWindowingResult {
  const selectedCodeUnits = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  if (selectedCodeUnits > PROMPT_INJECTION_MAX_SELECTED_CODE_UNITS) {
    return {
      decision: "limit_exceeded",
      evaluatedMessageCount: messages.length,
      evaluatedWindowCount: 0,
    };
  }

  const windows: PromptInjectionTokenWindow[] = [];
  for (const message of messages) {
    const tokenIds = encode(message.content);
    let start = 0;

    while (start < tokenIds.length || (start === 0 && tokenIds.length === 0)) {
      windows.push(
        createWindow(message, tokenIds.slice(start, start + CONTENT_CAPACITY)),
      );
      if (windows.length > PROMPT_INJECTION_MAX_WINDOWS) {
        return {
          decision: "limit_exceeded",
          evaluatedMessageCount: messages.length,
          evaluatedWindowCount: PROMPT_INJECTION_MAX_WINDOWS,
        };
      }
      if (start + CONTENT_CAPACITY >= tokenIds.length) break;
      start += WINDOW_ADVANCE;
    }
  }

  return {
    decision: "ready",
    windows,
    evaluatedMessageCount: messages.length,
  };
}
