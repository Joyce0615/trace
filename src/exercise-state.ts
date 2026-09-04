import type { Architecture, SymbolFlow, CallChain, LocalizationExercise, LocalizationHint, LocalizationScore, PredictionExercise, PredictionGrade, RaceReport, RaceTask, TraceRunResult, TraceRuntime } from "./types";

/**
 * Exercise state shapes.
 *
 * `App` owns this state so a learner never loses work when switching workspace
 * tabs, but it must not drag the (lazily loaded) exercise panels into the entry
 * chunk, so the shapes live in their own tiny module.
 */

export type ChainState = {
  chains: CallChain[];
  exercises: PredictionExercise[];
  activeChain: string | null;
  choice: Record<string, string>;
  grades: Record<string, PredictionGrade>;
  status: "idle" | "loading" | "ready" | "empty" | "error";
};

export type LocalizationState = {
  exercise: LocalizationExercise | null;
  trailStart: number;
  selected: string[];
  hints: LocalizationHint[];
  score: LocalizationScore | null;
  error: string | null;
};

export type ReviewState = {
  task: RaceTask | null;
  understanding: string;
  plan: string;
  files: string[];
  report: RaceReport | null;
  error: string | null;
};

export type TraceState = {
  runtimes: Record<string, TraceRuntime> | null;
  snippet: string;
  result: TraceRunResult | null;
  busy: boolean;
  error: string | null;
};

export const emptyTraceState: TraceState = { runtimes: null, snippet: "", result: null, busy: false, error: null };

export type ArchitectureState = {
  architecture: Architecture | null;
  flow: SymbolFlow | null;
  activeModule: string | null;
  status: "idle" | "loading" | "ready" | "error";
};

export const emptyArchitectureState: ArchitectureState = { architecture: null, flow: null, activeModule: null, status: "idle" };

export const emptyChainState: ChainState = { chains: [], exercises: [], activeChain: null, choice: {}, grades: {}, status: "idle" };
export const emptyLocalizationState: LocalizationState = { exercise: null, trailStart: 0, selected: [], hints: [], score: null, error: null };
export const emptyReviewState: ReviewState = { task: null, understanding: "", plan: "", files: [], report: null, error: null };
