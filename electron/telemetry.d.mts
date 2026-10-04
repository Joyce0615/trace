/**
 * Types for the shared telemetry module, so the browser demo enforces the same
 * consent gate, the same folding rules, and the same bucketing as the desktop
 * application rather than an imitation of them.
 */
import type { TelemetrySummary } from "../src/types";

export type TelemetrySeries = {
  key: string;
  event: string;
  day: string;
  dimensions: Record<string, string>;
  count: number;
  buckets: Record<string, Record<string, number>>;
};

export type TelemetryState = {
  format?: string;
  version?: number;
  consent: { granted: boolean; changedAt: string | null };
  series: TelemetrySeries[];
  folded: { dimensionValues: number; series: number };
  destination?: "local-only";
  destinationNote?: string;
};

export type TelemetryEventDefinition = {
  what: string;
  dimensions: Record<string, string[]>;
  measures: Record<string, string>;
};

export declare const TELEMETRY_VERSION: number;
export declare const TELEMETRY_FORMAT: string;
export declare const RETENTION_DAYS: number;
export declare const MAX_SERIES_PER_EVENT: number;
export declare const MAX_TOTAL_SERIES: number;
export declare const LADDERS: Record<string, number[]>;
export declare const TELEMETRY_EVENTS: Record<string, TelemetryEventDefinition>;
export declare function telemetryEventNames(): string[];
export declare function createTelemetryState(): TelemetryState;
export declare function setConsent(state: TelemetryState | Record<string, unknown>, granted: boolean, now?: Date): TelemetryState;
export declare function bucketFor(value: number, ladder: string): string;
export declare function normalizeEvent(name: string, payload?: { dimensions?: Record<string, unknown>; measures?: Record<string, unknown> }): { ok: boolean; reason: string | null; detail?: string; event?: string; dimensions?: Record<string, string>; buckets?: Record<string, string>; foldedValues?: number };
export declare function recordEvent(state: TelemetryState | Record<string, unknown>, name: string, payload?: { dimensions?: Record<string, unknown>; measures?: Record<string, unknown> }, now?: Date): { state: TelemetryState; recorded: boolean; reason: string | null; detail: string | null };
export declare function pruneRetention(state: TelemetryState | Record<string, unknown>, now?: Date, retentionDays?: number): TelemetryState;
export declare function forget(state: TelemetryState | Record<string, unknown>, options?: { event?: string | null }): { state: TelemetryState; deletedSeries: number; deletedEvents: number };
export declare function summarize(state: TelemetryState | Record<string, unknown>, now?: Date): TelemetrySummary;
export declare function exportTelemetry(state: TelemetryState | Record<string, unknown>, now?: Date): Record<string, unknown>;
export declare function containsOnlyDeclaredValues(state: TelemetryState | Record<string, unknown>): { clean: boolean; offenders: string[] };
