/**
 * Types for the shared deep-link parser, so the browser demo refuses exactly
 * the links the desktop app refuses.
 */
import type { DeepLinkResult } from "../src/types";

export declare const DEEP_LINK_VERSION: number;
export declare const DEEP_LINK_SCHEME: string;
export declare const DEEP_LINK_ACTIONS: Record<string, { required: string[]; optional: string[] }>;
export declare const DEEP_LINK_VIEWS: string[];

export declare function isSafeRelativePath(value: unknown): boolean;
export declare function parseDeepLink(
  url: string,
  options?: { openRepositories?: Array<{ id: string; rootPath: string }> },
): Omit<DeepLinkResult, "url" | "at">;
export declare function formatDeepLink(intent: { action?: string; repository?: { rootPath: string }; repo?: string; file?: string | null; line?: number | null; lesson?: string | null; view?: string | null }): string;
export declare function deepLinkFromArgv(argv?: string[]): string | null;
