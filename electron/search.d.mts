/**
 * Types for the shared retrieval module.
 *
 * `search.mjs` is imported by both the Electron main process and the browser
 * demo, so the renderer's TypeScript build needs declarations for it.
 */
import type { Repository, SearchResponse } from "../src/types";

export declare const SEARCH_VERSION: number;
export declare const EMBEDDING_DIMENSIONS: number;
export declare const DEFAULT_SEARCH_LIMITS: {
  maxIndexedFiles: number;
  maxFileBytes: number;
  maxTokensPerFile: number;
  maxResults: number;
};

export interface SearchIndex {
  version: number;
  repositoryId: string;
  sourceVersion?: string;
  stats: { indexedFiles: number; candidateFiles: number; vocabulary: number };
  limits: typeof DEFAULT_SEARCH_LIMITS;
}

export declare function tokenize(text: string): string[];
export declare function embed(text: string): Float64Array;
export declare function cosine(left: Float64Array, right: Float64Array): number;
export declare function subsequenceScore(query: string, candidate: string): number;
export declare function editDistance(left: string, right: string, limit?: number): number;
export declare function similarityScore(query: string, candidate: string): number;
export declare function buildSearchIndex(
  repository: Pick<Repository, "id" | "files" | "symbols"> & { versionId?: string; imports?: Repository["imports"]; callEdges?: Repository["callEdges"] },
  options: { read: (filePath: string) => Promise<string> | string; limits?: Partial<typeof DEFAULT_SEARCH_LIMITS> },
): Promise<SearchIndex>;
export declare function search(
  index: SearchIndex,
  query: string,
  options?: { limit?: number; rrfK?: number; weights?: Record<string, number> },
): SearchResponse;
