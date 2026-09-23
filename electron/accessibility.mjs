/**
 * An accessibility auditor the product owns, rather than a promise in a README.
 *
 * "Accessible" is not a property anyone can hold in their head across a UI this
 * size: sixty panels, twenty of them lazily loaded, all of them growing. The
 * only version of this that stays true is one that fails the build, so the
 * rules live here as code and both smoke tests run them against the real DOM.
 *
 * Two decisions are worth stating.
 *
 * **The snapshot is collected by this module too.** `collectAccessibilitySnapshot`
 * is a self-contained function the tests hand to the browser, so the desktop
 * app and the browser demo are measured by the same collector as well as the
 * same rules. A rule that depends on how the test happened to serialise the DOM
 * is a rule that passes for the wrong reason.
 *
 * **Every rule cites the thing it failed on.** A violation carries a selector, a
 * severity, and a sentence describing what a person using the app would hit —
 * not a rule id and a count. An audit nobody can act on is an audit nobody runs
 * twice.
 *
 * The checks implement the WCAG success criteria that can be decided from a
 * static snapshot. They are deliberately *not* presented as proof of
 * conformance: a machine cannot tell whether an accessible name is a useful
 * one, and no rule here claims to.
 */

export const A11Y_VERSION = 1;

/** Roles that are interactive and therefore need an accessible name. */
export const NAMED_ROLES = new Set(["button", "link", "tab", "checkbox", "radio", "switch", "textbox", "combobox", "menuitem", "option", "slider", "searchbox"]);

/**
 * Roles whose accessible name comes from their own content, per accname. The
 * complement matters more than the list: landmarks, dialogs, regions, and form
 * controls need a name given to them.
 */
export const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "option", "menuitem", "checkbox", "radio", "switch", "treeitem", "cell", "columnheader", "rowheader", "tooltip"]);

/** Landmarks that may appear only once unless each copy is named. */
export const UNIQUE_LANDMARKS = new Set(["main", "banner", "contentinfo"]);

export const SEVERITIES = { critical: 3, serious: 2, moderate: 1 };

/**
 * Collect everything the rules need, in one pass, in the page.
 *
 * Written as a single self-contained function with no closure so it can be
 * handed straight to `page.evaluate`. It reads computed styles once per element
 * because doing it lazily inside the rules would force a layout per query and
 * turn a 2,000-element audit into a minute.
 */
export function collectAccessibilitySnapshot() {
  const INTERESTING = new Set(["role", "type", "alt", "title", "href", "id", "disabled", "hidden", "placeholder", "value", "for", "name", "contenteditable"]);
  const elements = [...document.querySelectorAll("*")];
  const indexOf = new Map(elements.map((element, index) => [element, index]));
  const nodes = elements.map((element, index) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const attribute of element.attributes) {
      if (INTERESTING.has(attribute.name) || attribute.name.startsWith("aria-") || attribute.name === "tabindex") {
        attributes[attribute.name] = attribute.value;
      }
    }
    // Own text only: a button's name should not be inherited from a paragraph
    // that happens to be inside a container three levels up.
    let ownText = "";
    for (const child of element.childNodes) {
      if (child.nodeType === 3) ownText += child.nodeValue;
    }
    const parent = element.parentElement;
    return {
      index,
      tag: element.tagName.toLowerCase(),
      parentIndex: parent ? indexOf.get(parent) ?? -1 : -1,
      classes: typeof element.className === "string" ? element.className.split(/\s+/).filter(Boolean).slice(0, 6) : [],
      attributes,
      ownText: ownText.trim().slice(0, 200),
      text: (element.textContent ?? "").trim().slice(0, 200),
      tabIndex: element.tabIndex,
      disabled: Boolean(element.disabled),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: Number.parseFloat(style.fontSize) || 0,
      fontWeight: Number(style.fontWeight) || 400,
      outlineStyle: style.outlineStyle,
    };
  });
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || "",
    activeElementIndex: document.activeElement ? indexOf.get(document.activeElement) ?? -1 : -1,
    nodes,
  };
}

function parseColor(value) {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(String(value ?? ""));
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

function channelLuminance(channel) {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, per WCAG 2.x. */
export function relativeLuminance(color) {
  return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b);
}

/** Contrast ratio between two rgb(a) strings, or null when either is unreadable. */
export function contrastRatio(foreground, background) {
  const front = parseColor(foreground);
  const back = parseColor(background);
  if (!front || !back) return null;
  // A translucent foreground is composited over the background before comparing,
  // because that is what a reader actually sees.
  const blended = front.a >= 1 ? front : {
    r: front.r * front.a + back.r * (1 - front.a),
    g: front.g * front.a + back.g * (1 - front.a),
    b: front.b * front.a + back.b * (1 - front.a),
  };
  const lighter = Math.max(relativeLuminance(blended), relativeLuminance(back));
  const darker = Math.min(relativeLuminance(blended), relativeLuminance(back));
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

/** WCAG's "large text" threshold, which lowers the required ratio to 3:1. */
export function isLargeText(fontSize, fontWeight) {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
}

function selectorFor(node) {
  const id = node.attributes.id;
  if (id) return `#${id}`;
  const classes = node.classes.length ? `.${node.classes.join(".")}` : "";
  const label = node.attributes["aria-label"] ? `[aria-label="${node.attributes["aria-label"]}"]` : "";
  const text = node.ownText ? ` (“${node.ownText.slice(0, 40)}”)` : "";
  return `${node.tag}${classes}${label}${text}`;
}

const IMPLICIT_ROLES = {
  button: "button",
  a: "link",
  input: "textbox",
  textarea: "textbox",
  select: "combobox",
  summary: "button",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  nav: "navigation",
  aside: "complementary",
  form: "form",
  img: "img",
  dialog: "dialog",
};

/** Elements that scope a `header`, `footer`, or `aside` out of being a landmark. */
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);

function hasSectioningAncestor(node, byIndex, scopes = SECTIONING) {
  let current = byIndex?.get(node.parentIndex);
  let depth = 0;
  while (current && depth < 60) {
    if (scopes.has(current.tag)) return true;
    current = byIndex.get(current.parentIndex);
    depth += 1;
  }
  return false;
}

/**
 * The role an element actually exposes: explicit if given, implicit otherwise.
 *
 * `byIndex` is optional but changes the answer for `header`, `footer`, and
 * `aside`, which are landmarks only at the top level. Without it the auditor
 * reported eight banner landmarks on a page with one, because every panel has a
 * `<header>` inside its own `<section>` — a false failure, and a false failure
 * is how an audit gets switched off.
 */
export function roleOf(node, byIndex = null) {
  if (node.attributes.role) return node.attributes.role;
  if (node.tag === "a" && !node.attributes.href) return null;
  if ((node.tag === "header" || node.tag === "footer" || node.tag === "aside") && byIndex && hasSectioningAncestor(node, byIndex)) return null;
  if (node.tag === "input") {
    const type = (node.attributes.type ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "search") return "searchbox";
    if (type === "hidden") return null;
    return "textbox";
  }
  return IMPLICIT_ROLES[node.tag] ?? null;
}

function indexById(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    const id = node.attributes.id;
    if (id && !byId.has(id)) byId.set(id, node);
  }
  return byId;
}

/**
 * The accessible name, computed in the order the accname specification uses:
 * `aria-labelledby`, then `aria-label`, then the element's own content, then
 * `title`. This is a faithful subset — enough to decide whether a name exists,
 * which is the question the rules ask.
 */
export function accessibleName(node, nodes, byId = indexById(nodes), byIndex = null) {
  const labelledBy = node.attributes["aria-labelledby"];
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => byId.get(id)?.text ?? "").filter(Boolean);
    if (parts.length) return parts.join(" ").trim();
  }
  if (node.attributes["aria-label"]?.trim()) return node.attributes["aria-label"].trim();
  if (["input", "select", "textarea"].includes(node.tag)) {
    if (node.attributes.id) {
      const label = nodes.find((candidate) => candidate.tag === "label" && candidate.attributes.for === node.attributes.id);
      if (label?.text) return label.text;
    }
    // Implicit labelling: `<label><input …><span>Yes</span></label>` is how HTML
    // has always let a control borrow the text around it, and treating it as
    // unlabelled reported twelve false failures on a dialog that was fine.
    const owner = ancestorLabel(node, nodes);
    if (owner?.text) return owner.text;
  }
  if (node.tag === "img") return node.attributes.alt?.trim() ?? "";
  // Only some roles take their name from what is inside them. A landmark, a
  // dialog, or a region does not: two `<main>` elements full of different prose
  // are still two unnamed mains, and treating their content as a name reported
  // them as distinctly labelled when a reader hears "main, main".
  if (NAME_FROM_CONTENT.has(roleOf(node, byIndex) ?? "") && node.text) return node.text;
  if (node.attributes.title?.trim()) return node.attributes.title.trim();
  if (node.attributes.placeholder?.trim()) return node.attributes.placeholder.trim();
  return "";
}

function ancestorLabel(node, nodes) {
  const byIndex = new Map(nodes.map((candidate) => [candidate.index, candidate]));
  let current = byIndex.get(node.parentIndex);
  let depth = 0;
  while (current && depth < 8) {
    if (current.tag === "label") return current;
    current = byIndex.get(current.parentIndex);
    depth += 1;
  }
  return null;
}

function isRendered(node, byIndex) {
  let current = node;
  let depth = 0;
  while (current && depth < 60) {
    if (current.display === "none" || current.visibility === "hidden" || current.attributes.hidden !== undefined) return false;
    if (current.attributes["aria-hidden"] === "true") return false;
    current = current.parentIndex >= 0 ? byIndex.get(current.parentIndex) : null;
    depth += 1;
  }
  return true;
}

function inAriaHidden(node, byIndex) {
  let current = byIndex.get(node.parentIndex);
  let depth = 0;
  while (current && depth < 60) {
    if (current.attributes["aria-hidden"] === "true") return true;
    current = byIndex.get(current.parentIndex);
    depth += 1;
  }
  return false;
}

/**
 * Audit a snapshot.
 *
 * `options.only` narrows to a subtree by class, which the smoke tests use to
 * audit one panel at a time; `options.skipRules` exists so a rule can be turned
 * off *loudly*, in the caller, rather than by weakening the rule for everyone.
 */
export function auditSnapshot(snapshot, options = {}) {
  const skip = new Set(options.skipRules ?? []);
  const nodes = snapshot?.nodes ?? [];
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const byId = indexById(nodes);
  const violations = [];
  const add = (rule, severity, node, detail) => {
    if (skip.has(rule)) return;
    violations.push({ rule, severity, selector: node ? selectorFor(node) : snapshot?.url ?? "document", detail });
  };

  const rendered = nodes.filter((node) => isRendered(node, byIndex));
  const interactive = rendered.filter((node) => {
    const role = roleOf(node, byIndex);
    return (role && NAMED_ROLES.has(role)) || node.tabIndex >= 0;
  });

  // --- Document ------------------------------------------------------------
  if (!snapshot?.lang) add("html-lang", "serious", null, "The document has no lang attribute, so a screen reader cannot choose a pronunciation.");
  if (!snapshot?.title?.trim()) add("document-title", "serious", null, "The document has no title.");

  // --- Duplicate ids -------------------------------------------------------
  const idCounts = new Map();
  for (const node of nodes) {
    const id = node.attributes.id;
    if (!id) continue;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) add("duplicate-id", "serious", byId.get(id), `id "${id}" is used ${count} times, so every aria reference to it is ambiguous.`);
  }

  // --- Names on interactive things ----------------------------------------
  for (const node of interactive) {
    if (node.disabled) continue;
    const name = accessibleName(node, nodes, byId, byIndex);
    if (!name) add("interactive-name", "critical", node, `A ${roleOf(node, byIndex) ?? node.tag} is reachable but has no accessible name, so it is announced only as "${roleOf(node, byIndex) ?? "element"}".`);
  }

  // --- Tab order -----------------------------------------------------------
  for (const node of rendered) {
    if (node.tabIndex > 0) add("no-positive-tabindex", "serious", node, `tabindex="${node.tabIndex}" overrides the document order and breaks tabbing for everyone else.`);
  }

  // --- Things hidden from assistive technology but still focusable ---------
  for (const node of nodes) {
    if (node.tabIndex < 0 || node.disabled) continue;
    if (node.attributes["aria-hidden"] === "true" || inAriaHidden(node, byIndex)) {
      if (isRendered({ ...node, attributes: { ...node.attributes, "aria-hidden": undefined } }, byIndex)) {
        add("focusable-aria-hidden", "critical", node, "This is focusable but hidden from assistive technology, so keyboard focus lands somewhere a screen reader cannot describe.");
      }
    }
  }

  // --- Labels on form controls --------------------------------------------
  for (const node of rendered) {
    if (!["input", "textarea", "select"].includes(node.tag)) continue;
    if ((node.attributes.type ?? "").toLowerCase() === "hidden") continue;
    if (!accessibleName(node, nodes, byId, byIndex)) add("control-label", "critical", node, "This form control has no label.");
  }

  // --- Headings ------------------------------------------------------------
  const headings = rendered.filter((node) => /^h[1-6]$/.test(node.tag)).map((node) => ({ node, level: Number(node.tag[1]) }));
  let previous = 0;
  for (const heading of headings) {
    if (previous && heading.level > previous + 1) {
      add("heading-order", "moderate", heading.node, `Heading level jumps from h${previous} to h${heading.level}, so the outline has a gap.`);
    }
    previous = heading.level;
  }

  // --- Landmarks -----------------------------------------------------------
  const landmarkCounts = new Map();
  for (const node of rendered) {
    const role = roleOf(node, byIndex);
    if (!role || !UNIQUE_LANDMARKS.has(role)) continue;
    if (!landmarkCounts.has(role)) landmarkCounts.set(role, []);
    landmarkCounts.get(role).push(node);
  }
  for (const [role, found] of landmarkCounts) {
    const names = found.map((node) => accessibleName(node, nodes, byId, byIndex));
    if (found.length > 1 && new Set(names).size !== found.length) {
      add("landmark-unique", "moderate", found[1], `There are ${found.length} ${role} landmarks and they are not distinctly named.`);
    }
  }
  if (!landmarkCounts.get("main")?.length && rendered.length > 30) {
    add("landmark-main", "serious", null, "The page has no main landmark, so there is nothing to skip to.");
  }

  // --- Tabs ----------------------------------------------------------------
  for (const node of rendered) {
    if (roleOf(node, byIndex) !== "tab") continue;
    if (node.attributes["aria-selected"] === undefined) add("tab-selected", "serious", node, "A tab does not say whether it is selected.");
    const parent = byIndex.get(node.parentIndex);
    if (!parent || roleOf(parent, byIndex) !== "tablist") add("tab-parent", "moderate", node, "A tab is not inside a tablist, so it is announced as a lone button.");
  }
  for (const node of rendered) {
    if (roleOf(node, byIndex) !== "tablist") continue;
    const tabs = rendered.filter((candidate) => candidate.parentIndex === node.index && roleOf(candidate, byIndex) === "tab");
    if (!tabs.length) { add("tablist-empty", "moderate", node, "A tablist contains no tabs."); continue; }
    // Roving tabindex: exactly one tab is in the tab order, and it is the
    // selected one. Without this, tabbing through the app walks every tab.
    const inOrder = tabs.filter((tab) => tab.tabIndex === 0);
    if (inOrder.length !== 1) add("tablist-roving", "serious", node, `${inOrder.length} of ${tabs.length} tabs are in the tab order; a tablist should expose exactly one.`);
    const selected = tabs.filter((tab) => tab.attributes["aria-selected"] === "true");
    if (selected.length === 1 && inOrder.length === 1 && selected[0].index !== inOrder[0].index) {
      add("tablist-roving", "serious", node, "The tab in the tab order is not the selected one.");
    }
  }

  // --- Dialogs -------------------------------------------------------------
  for (const node of rendered) {
    if (roleOf(node, byIndex) !== "dialog") continue;
    if (!accessibleName(node, nodes, byId, byIndex)) add("dialog-name", "critical", node, "A dialog has no accessible name.");
    if (node.attributes["aria-modal"] !== "true") add("dialog-modal", "serious", node, "A dialog that covers the app does not declare aria-modal, so the content behind it stays reachable.");
  }

  // --- aria references resolve --------------------------------------------
  for (const node of nodes) {
    for (const attribute of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-activedescendant"]) {
      const value = node.attributes[attribute];
      if (!value) continue;
      for (const id of value.split(/\s+/).filter(Boolean)) {
        if (!byId.has(id)) add("aria-reference", "serious", node, `${attribute} points at "${id}", which is not in the document.`);
      }
    }
  }

  // --- Images --------------------------------------------------------------
  for (const node of rendered) {
    if (node.tag === "img" && node.attributes.alt === undefined) add("image-alt", "critical", node, "An image has no alt attribute, so its file name is read out instead.");
    if (node.tag === "svg" && node.attributes["aria-hidden"] !== "true" && !node.attributes["aria-label"] && !node.attributes.role) {
      add("decorative-svg", "moderate", node, "A decorative svg is not hidden from assistive technology.");
    }
  }

  // --- Target size (WCAG 2.2, 2.5.8) --------------------------------------
  for (const node of interactive) {
    if (node.disabled || node.tag === "a") continue;
    // A zero-dimension element is not a target anybody can hit.
    if (node.width === 0 || node.height === 0) continue;
    // The specification's Inline exception: a control sitting inside a sentence
    // is sized by the line, and growing it would break the sentence.
    const parent = byIndex.get(node.parentIndex);
    if (parent?.ownText) continue;
    // A checkbox wrapped in a label is clickable across the whole label, and the
    // label is the target a person actually hits.
    const owner = ancestorLabel(node, nodes);
    const width = Math.max(node.width, owner?.width ?? 0);
    const height = Math.max(node.height, owner?.height ?? 0);
    if (width < 24 || height < 24) {
      add("target-size", "moderate", node, `The target is ${width}x${height} CSS pixels; 24x24 is the minimum.`);
    }
  }

  // --- Contrast ------------------------------------------------------------
  for (const node of rendered) {
    if (!node.ownText) continue;
    const background = backgroundBehind(node, byIndex);
    const ratio = contrastRatio(node.color, background);
    if (ratio === null) continue;
    const required = isLargeText(node.fontSize, node.fontWeight) ? 3 : 4.5;
    if (ratio < required) {
      add("contrast", "serious", node, `Text contrast is ${ratio}:1 against ${background}; ${required}:1 is required at ${Math.round(node.fontSize)}px.`);
    }
  }

  const counts = violations.reduce((totals, violation) => ({ ...totals, [violation.severity]: (totals[violation.severity] ?? 0) + 1 }), {});
  return {
    version: A11Y_VERSION,
    url: snapshot?.url ?? null,
    elements: nodes.length,
    rendered: rendered.length,
    interactive: interactive.length,
    violations: violations.sort((left, right) => (SEVERITIES[right.severity] ?? 0) - (SEVERITIES[left.severity] ?? 0)),
    counts,
    passed: violations.length === 0,
  };
}

/**
 * The colour actually painted behind an element.
 *
 * Translucent layers are composited rather than returned as-is. Returning the
 * first non-transparent background reported a 1:1 ratio for text on a 3.5%
 * green tint — the tint was treated as the background instead of as a film over
 * the panel — which is a false failure, and a false failure is how an audit
 * stops being run.
 */
function backgroundBehind(node, byIndex) {
  const layers = [];
  let current = node;
  let depth = 0;
  while (current && depth < 60) {
    const color = parseColor(current.backgroundColor);
    if (color && color.a > 0) {
      layers.push(color);
      if (color.a >= 1) break;
    }
    current = current.parentIndex >= 0 ? byIndex.get(current.parentIndex) : null;
    depth += 1;
  }
  let base = layers.length && layers.at(-1).a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const over = layers[index];
    base = {
      r: over.r * over.a + base.r * (1 - over.a),
      g: over.g * over.a + base.g * (1 - over.a),
      b: over.b * over.a + base.b * (1 - over.a),
      a: 1,
    };
  }
  return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
}

/** A one-line summary for a report; the violations themselves carry the detail. */
export function summarizeAudit(audit) {
  if (audit.passed) return `${audit.rendered} rendered elements, ${audit.interactive} interactive, no violations.`;
  const parts = Object.entries(audit.counts).map(([severity, count]) => `${count} ${severity}`);
  return `${audit.violations.length} violation(s): ${parts.join(", ")}.`;
}
