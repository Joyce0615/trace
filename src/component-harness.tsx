import { StrictMode, Suspense, lazy, useState } from "react";
import { createRoot } from "react-dom/client";
import { VirtualList } from "./shell";
import "./styles.css";

/**
 * A harness for testing one component at a time (item 53).
 *
 * The smoke tests drive the whole application, which is the right way to find
 * out whether it works and the wrong way to find out whether a *component*
 * does: reaching a panel's empty state or its error state through the real app
 * means arranging for a real failure, so those branches went untested for
 * fifteen items. Here each component is mounted alone with props supplied by
 * the URL, so the states that are hard to reach are the easy ones to check.
 *
 * `components.html` is deliberately *not* added to the production build's
 * inputs: making it a second Rollup entry point re-chunked the shipped app to
 * share code with a test fixture, which is a real cost paid for nothing. The
 * harness is served by the dev server, which is where the component tests run.
 */

const parameters = new URLSearchParams(location.search);
// Props arrive as JSON in the URL, so they are `any` by construction; the
// harness is a test fixture and types nothing it does not need to.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const props: any = JSON.parse(parameters.get("props") ?? "{}");

const LazyPanels = {
  SharingPanel: lazy(async () => ({ default: (await import("./exercises")).SharingPanel })),
  MigrationPanel: lazy(async () => ({ default: (await import("./exercises")).MigrationPanel })),
  ArchivePanel: lazy(async () => ({ default: (await import("./exercises")).ArchivePanel })),
  GoalPanel: lazy(async () => ({ default: (await import("./exercises")).GoalPanel })),
  CallChainPanel: lazy(async () => ({ default: (await import("./exercises")).CallChainPanel })),
  ArchitecturePanel: lazy(async () => ({ default: (await import("./exercises")).ArchitecturePanel })),
} as const;

/** A list long enough that windowing is the only reason it renders quickly. */
function VirtualListCase({ total, height }: { total: number; height: number }) {
  const [scrolled, setScrolled] = useState(0);
  const items = Array.from({ length: total }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}` }));
  return <div>
    <VirtualList
      items={items}
      itemHeight={26}
      height={height}
      className="file-list"
      label={`${total} rows`}
      keyFor={(item) => item.id}
      onScrollTopChange={setScrolled}
      renderItem={(item) => <button className="file-row" title={item.id}>{item.label}</button>}
    />
    <p data-scrolled={scrolled}>scrolled {scrolled}</p>
  </div>;
}

function Harness() {
  const name = parameters.get("component") ?? "";
  if (name === "VirtualList") return <VirtualListCase total={props.total ?? 5_000} height={props.height ?? 260} />;
  const Panel = LazyPanels[name as keyof typeof LazyPanels];
  if (!Panel) return <p data-harness="unknown">No component named “{name}”.</p>;
  return <Suspense fallback={<p data-harness="loading">Loading…</p>}>
    <Panel {...props} />
  </Suspense>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><div data-harness="ready"><Harness /></div></StrictMode>);
