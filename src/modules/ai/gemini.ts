import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type Content,
} from '@google/genai';

import { SYSTEM_PROMPT } from './system-prompt.js';
import { logger, errorInfo, type Logger } from '../logger/logger.js';

interface ReplyOptions {
  bookingSessionId?: string | null;
  systemInstruction?: string;
  contents?: Content[];
  responseJsonSchema?: Record<string, unknown>;
}

interface GeminiConfig {
  apiKey: string;
  model: string;
  audit?: Logger;
}

export function createGeminiService(config: GeminiConfig) {
  const audit = config.audit ?? logger;
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      timeout: 30_000,
      retryOptions: {
        attempts: 1,
        initialDelay: 1,
        maxDelay: 4,
        expBase: 2,
        jitter: 0.5,
        httpStatusCodes: [408, 500, 502, 503, 504],
      },
    },
  });

  let history: Content[] = [];
  let pausedUntil = 0;

  async function generateReply(
    text: string,
    signal: AbortSignal,
    options: ReplyOptions = {},
  ): Promise<{ text: string; content: Content }> {
    if (!text.trim() || text.length > 4096) {
      throw new Error('GEMINI_INPUT');
    }

    if (Date.now() < pausedUntil) {
      throw new Error('GEMINI_COOLDOWN');
    }

    let response;

    try {
      response = await ai.models.generateContent({
        model: config.model,
        contents: options.contents ?? [
          ...history,
          { role: 'user', parts: [{ text }] },
        ],
        config: {
          systemInstruction: options.systemInstruction ?? SYSTEM_PROMPT,
          ...(options.responseJsonSchema ? {
            responseMimeType: 'application/json',
            responseJsonSchema: options.responseJsonSchema,
          } : {}),
          maxOutputTokens: 4096,
          abortSignal: signal,
        },
      });
    } catch (error) {
      if (signal.aborted) {
        throw new Error('GEMINI_CANCELLED');
      }

      if (error instanceof ApiError) {
        audit.technical('error', 'gemini.api_error', {
          model: config.model, status: error.status,
        }, options.bookingSessionId ?? null);
        if (error.status === 429) {
          pausedUntil = Date.now() + 60_000;
          throw new Error('GEMINI_RATE_LIMIT');
        }

        const codes: Record<number, string> = {
          400: 'GEMINI_BAD_REQUEST',
          401: 'GEMINI_AUTH',
          403: 'GEMINI_AUTH',
          404: 'GEMINI_MODEL',
          402: 'GEMINI_BILLING',
        };

        if (error.status >= 500 || error.status === 408) {
          throw new Error('GEMINI_UNAVAILABLE');
        }

        throw new Error(
          codes[error.status] ?? 'GEMINI_API',
        );
      }

      audit.technical('error', 'gemini.network_error', errorInfo(error), options.bookingSessionId ?? null);
      throw new Error('GEMINI_NETWORK');
    }

    const candidate = response.candidates?.[0];

    if (response.promptFeedback?.blockReason) {
      throw new Error('GEMINI_BLOCKED');
    }

    if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
      throw new Error('GEMINI_TRUNCATED');
    }

    if (
      candidate?.finishReason !== FinishReason.STOP ||
      !candidate.content?.parts?.length
    ) {
      throw new Error('GEMINI_BLOCKED');
    }

    const reply = response.text?.trim();

    if (!reply) {
      throw new Error('GEMINI_EMPTY');
    }

    if (reply.length > 4000) {
      throw new Error('GEMINI_REPLY_TOO_LONG');
    }

    return {
      text: reply,
      content: candidate.content,
    };
  }

  function rememberExchange(
    userText: string,
    modelContent: Content,
  ): void {
    history = [
      ...history,
      { role: 'user', parts: [{ text: userText }] },
      { ...modelContent, role: 'model' },
    ].slice(-20);
  }

  function reset(): void {
    history = [];
  }

  return {
    generateReply,
    rememberExchange,
    reset,
  };
}

export type GeminiService =
  ReturnType<typeof createGeminiService>;
