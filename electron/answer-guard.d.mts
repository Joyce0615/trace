/**
 * Types for the shared answer-guard and scaffolding module, so the browser demo
 * builds hint ladders with the same rules as the desktop app.
 */
import type { HintResponse, HintRung } from "../src/types";

export declare const ANSWER_GUARD_VERSION: number;
export declare const MIN_SCANNED_SECRET: number;
export declare const MAX_HINT_PENALTY: number;
export declare const ALWAYS_FORBIDDEN: string[];
export declare const RESPONSE_RULES: Record<string, string[]>;
export declare const SCANNED_CHANNELS: Set<string>;

export declare class AnswerLeakError extends Error {
  channel: string;
  details: string[];
  leak: true;
}

export type Scaffold = {
  version?: number;
  kind: HintResponse["kind"];
  available: boolean;
  reason?: string;
  rungs: Array<{ id: string; level: number; price: number; text: string }>;
  dropped?: string[];
  maxPenalty?: number;
};

export declare function registerAnswerSecrets(values: Array<string | number | null | undefined>): number;
export declare function clearAnswerSecrets(): void;
export declare function answerSecrets(): string[];
export declare function forbiddenKeysFor(channel: string): string[];
export declare function findForbiddenKeys(value: unknown, keys: string[], pointer?: string, found?: string[]): string[];
export declare function findLeakedValues(payload: unknown, secrets?: string[]): string[];
export declare function auditResponse(channel: string, response: unknown, secrets?: string[]): {
  version: number;
  channel: string;
  ok: boolean;
  forbiddenKeys: string[];
  leakedValues: string[];
  checkedKeys: string[];
};
export declare function guardResponse<T>(channel: string, response: T, secrets?: string[]): T;
export declare function buildScaffold(kind: HintResponse["kind"], context?: Record<string, unknown>): Scaffold;
export declare function nextHintRung(scaffold: Scaffold, used?: string[]): HintRung | null;
export declare function scaffoldPenalty(scaffold: Scaffold, used?: string[]): { revealed: string[]; ignored: string[]; penalty: number };
export declare function applyScaffold(score: number, scaffold: Scaffold, used?: string[]): { raw: number; penalty: number; revealed: string[]; ignored: string[]; score: number };
export declare function publicScaffold(scaffold: Scaffold): { version: number; kind: HintResponse["kind"]; available: boolean; reason?: string; total: number; prices: number[]; maxPenalty: number };
