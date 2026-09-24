/**
 * Types for the shared windowing module, so the renderer, the browser demo, and
 * the tests all compute the same visible slice.
 */
export interface ListWindow {
  start: number;
  end: number;
  count: number;
  offsetBefore: number;
  offsetAfter: number;
  totalHeight: number;
  clamped: boolean;
}

export interface GraphCulling<Node, Edge> {
  nodes: Node[];
  edges: Edge[];
  culledByViewport: number;
  culledByBudget: number;
  hiddenEdges: number;
  total: number;
  complete: boolean;
}

export declare const VIRTUALIZATION_VERSION: number;
export declare const DEFAULT_WINDOW: { overscan: number; maxRendered: number };

export declare function windowFor(options: { total: number; itemHeight: number; scrollTop?: number; viewportHeight: number; overscan?: number; maxRendered?: number }): ListWindow;
export declare function buildHeightIndex(heights: number[]): number[];
export declare function indexAt(offsets: number[], offset: number): number;
export declare function variableWindowFor(options: { heights: number[]; scrollTop?: number; viewportHeight: number; overscan?: number; maxRendered?: number }): ListWindow & { offsets: number[] };
export declare function scrollToIndex(options: { index: number; itemHeight: number; scrollTop?: number; viewportHeight: number; total: number }): number;
export declare function cullGraph<Node extends { id: string }, Edge>(options: {
  nodes?: Node[];
  edges?: Edge[];
  viewport?: { left: number; right: number; top: number; bottom: number } | null;
  budget?: number;
  importanceOf?: (node: Node) => number;
}): GraphCulling<Node, Edge>;
export declare function describeCulling(result: { complete: boolean; total: number; nodes: unknown[]; culledByViewport: number; culledByBudget: number }): string;
