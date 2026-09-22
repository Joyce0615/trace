import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Repository, TraceBridge } from "./types";

/**
 * Shared renderer primitives.
 *
 * The bridge, the icon set, and the two IPC helpers live outside `App.tsx` so
 * the lazily loaded exercise panels can use them without pulling the whole
 * application shell into their chunk.
 */

const missingDesktopBridge = new Proxy({}, {
  get() {
    return async () => { throw new Error("Desktop bridge failed to load. Restart Trace or reinstall the app."); };
  },
}) as unknown as TraceBridge;

/**
 * The browser demo, resolved on first use rather than imported.
 *
 * The demo implements every bridge method against a bundled fixture, which is
 * tens of kilobytes the desktop app can never execute: in Electron
 * `window.trace` is always present. Importing it eagerly put the entire fixture
 * in the entry chunk and spent most of the bundle budget on code one of the two
 * targets never runs. Every bridge method is already asynchronous and awaited,
 * so a proxy that loads the module on the first call is indistinguishable from
 * the real thing at the call site.
 */
const lazyBrowserBridge = new Proxy({}, {
  get(_target, method) {
    // `onIndexProgress` is the one member that is *not* a promise: it subscribes
    // and returns an unsubscribe function, which `useEffect` calls as cleanup.
    // Wrapping it like the rest handed React a promise as a destructor and
    // crashed the start screen with "destroy is not a function".
    if (method === "onIndexProgress") {
      return (callback: (progress: unknown) => void) => {
        let unsubscribe: (() => void) | null = null;
        let cancelled = false;
        void import("./demo").then(({ browserBridge }) => {
          if (cancelled) return;
          unsubscribe = browserBridge.onIndexProgress(callback as never) as unknown as () => void;
        });
        return () => { cancelled = true; unsubscribe?.(); };
      };
    }
    return async (...args: unknown[]) => {
      const { browserBridge } = await import("./demo");
      const implementation = (browserBridge as unknown as Record<string, (...rest: unknown[]) => unknown>)[String(method)];
      if (typeof implementation !== "function") throw new Error(`The browser demo does not implement ${String(method)}.`);
      return implementation(...args);
    };
  },
}) as unknown as TraceBridge;

export const bridge = window.trace ?? (navigator.userAgent.includes("Electron") ? missingDesktopBridge : lazyBrowserBridge);


/**
 * Start a panel's initial load exactly once per key, and never cancel it.
 *
 * Several panels shared a shape that was wrong in a way that only timing hid:
 * mark the state "loading", start a request, and cancel it from the effect's
 * cleanup — with `status` in the dependency list. Marking it loading changes
 * that dependency, so React ran the cleanup *immediately* and cancelled the
 * request the effect had just started. It worked only because the response
 * arrived on the microtask before React committed the re-render. Making the
 * browser demo lazy added one module fetch to that race and every one of those
 * panels hung on "Loading…" forever.
 *
 * There is also nothing to cancel. Panel state is owned by `App`, precisely so
 * that switching to the editor and back does not throw away work in progress, so
 * a result that arrives after the panel unmounts is *wanted*. The only event
 * that invalidates a request is the key changing, which is what `key` is for.
 */
export function useLoadOnce(key: string, ready: boolean, start: () => void) {
  const started = useRef<string | null>(null);
  // Deliberately no dependency array: the ref, not React's comparison, decides
  // when to run, which is the whole point.
  useEffect(() => {
    if (!ready || started.current === key) return;
    started.current = key;
    start();
  });
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    arrow: <><path d="m9 18 6-6-6-6" /><path d="M15 12H3" /></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 6h5a5 5 0 0 1 5 5v-3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
    folder: <><path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" /></>,
    git: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10a2 2 0 0 0 2 2h8M18 17V9a2 2 0 0 0-2-2H8" /></>,
    layers: <><path d="m12 2 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    spark: <path d="m12 3-1.6 4.4L6 9l4.4 1.6L12 15l1.6-4.4L18 9l-4.4-1.6ZM5 15l-.8 2.2L2 18l2.2.8L5 21l.8-2.2L8 18l-2.2-.8Z" />,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v3M21 12h-3M12 21v-3M3 12h3" /></>,
    terminal: <><path d="m4 17 6-5-6-5M12 19h8" /><rect width="20" height="18" x="2" y="3" rx="2" /></>,
    time: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}


/** The main process owns the index; the renderer only sends a repository reference. */
export function repositoryRef(repository: Repository) {
  return { id: repository.id, rootPath: repository.rootPath };
}

/** Electron wraps main-process errors; show the learner only the actionable message. */
export function readableError(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "")
    .trim();
}
