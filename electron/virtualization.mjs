/**
 * Windowing for long lists and large graphs.
 *
 * The honest starting point is that this app did not have a scale problem, it
 * had a *truncation* problem. The file tree rendered the first 180 files of a
 * 2,196-file repository and told the learner to "refine search to see more" —
 * which is not a performance trade-off, it is 2,016 files they cannot open.
 * The same shape appeared everywhere something might be long: cut the list,
 * apologise in the empty space.
 *
 * Virtualization removes the excuse. The whole collection stays addressable and
 * scrollable; only the part on screen exists in the DOM. Two properties make
 * that safe rather than merely fast:
 *
 *   - **The scrollbar tells the truth.** Total height is computed from every
 *     item, not from the rendered ones, so the thumb's size and position mean
 *     what they appear to mean and "scroll to the end" reaches the end.
 *   - **The window is bounded.** `maxRendered` caps how much can ever be in the
 *     DOM at once, so a viewport that is briefly enormous — a maximised window,
 *     a zoomed-out page — cannot turn one render into ten thousand nodes.
 *
 * Graphs get a different treatment, because a graph has no reading order: nodes
 * outside the viewport are culled, and when a graph is *still* too dense the
 * most important nodes are kept and the count of what was dropped is reported
 * rather than hidden.
 *
 * Node-free, so the renderer, the browser demo, and the tests share it.
 */

export const VIRTUALIZATION_VERSION = 1;

export const DEFAULT_WINDOW = {
  /** Rows rendered beyond the viewport, so a scroll does not flash empty space. */
  overscan: 6,
  /** The hard ceiling on rendered rows, whatever the viewport claims to be. */
  maxRendered: 200,
};

/**
 * The slice of a fixed-height list that is on screen.
 *
 * Returns the padding above and below as well as the range, because that is
 * what keeps the scroll height honest: the container is the full height, and
 * the rendered rows sit at the right offset inside it.
 */
export function windowFor({ total, itemHeight, scrollTop = 0, viewportHeight, overscan, maxRendered } = {}) {
  const options = { ...DEFAULT_WINDOW, overscan: overscan ?? DEFAULT_WINDOW.overscan, maxRendered: maxRendered ?? DEFAULT_WINDOW.maxRendered };
  const count = Math.max(0, Math.floor(total) || 0);
  const height = Math.max(1, itemHeight || 1);
  const viewport = Math.max(0, viewportHeight || 0);
  const totalHeight = count * height;
  if (!count) return { start: 0, end: 0, count: 0, offsetBefore: 0, offsetAfter: 0, totalHeight: 0, clamped: false };

  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewport)));
  const firstVisible = Math.floor(top / height);
  const visibleCount = Math.ceil(viewport / height) + 1;
  const start = Math.max(0, firstVisible - options.overscan);
  const wanted = visibleCount + options.overscan * 2;
  const clamped = wanted > options.maxRendered;
  const end = Math.min(count, start + Math.min(wanted, options.maxRendered));
  return {
    start,
    end,
    count: end - start,
    offsetBefore: start * height,
    offsetAfter: Math.max(0, (count - end) * height),
    totalHeight,
    // Stated rather than silent: a caller that hits the ceiling is showing less
    // than the viewport could hold, and should know.
    clamped,
  };
}

/**
 * Cumulative offsets for a variable-height list.
 *
 * Prefix sums make both directions O(log n): where does row `i` start, and
 * which row covers offset `y`. Recomputing by walking the array is fine for a
 * hundred rows and quadratic for a lesson with a thousand blocks.
 */
export function buildHeightIndex(heights) {
  const offsets = new Array((heights?.length ?? 0) + 1);
  offsets[0] = 0;
  for (let index = 0; index < (heights?.length ?? 0); index += 1) {
    offsets[index + 1] = offsets[index] + Math.max(0, heights[index] || 0);
  }
  return offsets;
}

/** The first row whose end is past `offset`; binary search over the prefix sums. */
export function indexAt(offsets, offset) {
  if (!offsets || offsets.length <= 1) return 0;
  const target = Math.max(0, Math.min(offset, offsets.at(-1)));
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= target) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, offsets.length - 2);
}

/** The window of a variable-height list that is on screen. */
export function variableWindowFor({ heights, scrollTop = 0, viewportHeight, overscan, maxRendered } = {}) {
  const options = { overscan: overscan ?? DEFAULT_WINDOW.overscan, maxRendered: maxRendered ?? DEFAULT_WINDOW.maxRendered };
  const list = heights ?? [];
  if (!list.length) return { start: 0, end: 0, count: 0, offsetBefore: 0, offsetAfter: 0, totalHeight: 0, clamped: false, offsets: [0] };
  const offsets = buildHeightIndex(list);
  const totalHeight = offsets.at(-1);
  const viewport = Math.max(0, viewportHeight || 0);
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewport)));
  const firstVisible = indexAt(offsets, top);
  const lastVisible = indexAt(offsets, top + viewport);
  const start = Math.max(0, firstVisible - options.overscan);
  const wanted = lastVisible - firstVisible + 1 + options.overscan * 2;
  const clamped = wanted > options.maxRendered;
  const end = Math.min(list.length, start + Math.min(wanted, options.maxRendered));
  return {
    start,
    end,
    count: end - start,
    offsetBefore: offsets[start],
    offsetAfter: Math.max(0, totalHeight - offsets[end]),
    totalHeight,
    clamped,
    offsets,
  };
}

/**
 * Where to scroll so that a row is on screen.
 *
 * Only moves when the row is actually outside the viewport, because a keyboard
 * user stepping down a list should see it move by one row, not re-centre on
 * every press.
 */
export function scrollToIndex({ index, itemHeight, scrollTop = 0, viewportHeight, total }) {
  const height = Math.max(1, itemHeight || 1);
  const clampedIndex = Math.max(0, Math.min(index, Math.max(0, (total ?? 0) - 1)));
  const rowTop = clampedIndex * height;
  const rowBottom = rowTop + height;
  if (rowTop < scrollTop) return rowTop;
  if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
  return scrollTop;
}

/**
 * Which graph nodes to draw.
 *
 * A graph has no reading order, so a window is the wrong shape: the viewport is
 * a rectangle, and what falls outside it is culled. When what remains is still
 * denser than the budget, the *most important* nodes survive — importance being
 * the graph's own ranking, not proximity to the centre — and the number dropped
 * is returned so the caller can say so instead of quietly drawing a partial
 * graph as though it were the whole one.
 */
export function cullGraph({ nodes = [], edges = [], viewport = null, budget = 300, importanceOf = (node) => node.importance ?? 0 } = {}) {
  const inside = viewport
    ? nodes.filter((node) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const width = node.width ?? 0;
      const height = node.height ?? 0;
      return x + width >= viewport.left && x <= viewport.right && y + height >= viewport.top && y <= viewport.bottom;
    })
    : [...nodes];

  const ranked = inside.length > budget
    ? [...inside].sort((left, right) => importanceOf(right) - importanceOf(left)).slice(0, budget)
    : inside;
  const visibleIds = new Set(ranked.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.from ?? edge.source) && visibleIds.has(edge.to ?? edge.target));

  return {
    nodes: ranked,
    edges: visibleEdges,
    culledByViewport: nodes.length - inside.length,
    culledByBudget: inside.length - ranked.length,
    hiddenEdges: edges.length - visibleEdges.length,
    total: nodes.length,
    complete: ranked.length === nodes.length && visibleEdges.length === edges.length,
  };
}

/** A sentence a panel can show, rather than a count nobody can interpret. */
export function describeCulling(result) {
  if (result.complete) return `Showing all ${result.total} nodes.`;
  const parts = [];
  if (result.culledByViewport) parts.push(`${result.culledByViewport} off screen`);
  if (result.culledByBudget) parts.push(`${result.culledByBudget} below the density budget`);
  return `Showing ${result.nodes.length} of ${result.total} nodes — ${parts.join(", ")}.`;
}
