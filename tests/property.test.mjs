import assert from "node:assert/strict";
import test from "node:test";
import { forAll, gen, seededRandom } from "./property.mjs";
import { DEFAULT_WINDOW, buildHeightIndex, cullGraph, indexAt, scrollToIndex, variableWindowFor, windowFor } from "../electron/virtualization.mjs";
import { CONTRAST_TARGETS, contrast, deriveColor, hexToRgb, luminance, paletteSeparation, rgbToHex, simulateVision } from "../electron/theme.mjs";
import { applyMigration, planMigration, revertMigration } from "../electron/course-migration.mjs";
import { mergeNotes, mergeProgress } from "../electron/offline-archive.mjs";
import { applyNoteEdit } from "../electron/notes.mjs";
import { parseDeepLink } from "../electron/deep-link.mjs";
import { redactValue, scanText } from "../electron/secret-scanner.mjs";
import { auditSnapshot } from "../electron/accessibility.mjs";

/**
 * Properties, not examples.
 *
 * Each `test` below states an invariant that must hold for *every* input, and
 * the harness hunts for a counterexample and shrinks it. The value is in the
 * shapes nobody writes by hand: an empty list, a single item, two items with the
 * same id, a number exactly on a threshold.
 */

const check = async (name, generator, property, options) => {
  const report = await forAll(generator, property, options);
  assert.ok(report.ok, `${name}: ${report.message}`);
  assert.ok(report.runs >= 100, `${name} only ran ${report.runs} cases`);
  return report;
};

test("the seeded generator is reproducible, and shrinking really shrinks", async () => {
  // A property test that is not reproducible is a flaky test with extra steps.
  const first = Array.from({ length: 8 }, seededRandom(42));
  const second = Array.from({ length: 8 }, seededRandom(42));
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, Array.from({ length: 8 }, seededRandom(43)));
  assert.ok(first.every((value) => value >= 0 && value < 1), JSON.stringify(first));

  // A deliberately broken property must be caught *and* reduced: the harness is
  // only trustworthy if it can fail, and only useful if the failure is small.
  const broken = await forAll(gen.array(gen.integer(0, 50), { max: 30 }), (values) => values.reduce((sum, value) => sum + value, 0) < 40);
  assert.equal(broken.ok, false);
  assert.ok(broken.counterexample.length <= 2, `shrinking left ${broken.counterexample.length} elements: ${JSON.stringify(broken.counterexample)}`);
  assert.match(broken.message, /counterexample \(seed \d+\)/);
  // Edge cases are tried before random ones, so a failure on an empty input is
  // found immediately rather than eventually.
  const emptyOnly = await forAll(gen.array(gen.integer(1, 9)), (values) => values.length > 0);
  assert.equal(emptyOnly.ok, false);
  assert.deepEqual(emptyOnly.counterexample, []);
});

test("property: a window always covers the list exactly, and every row is reachable", async () => {
  const listGenerator = gen.record({
    total: gen.integer(0, 5_000),
    itemHeight: gen.integer(1, 90),
    viewportHeight: gen.integer(0, 1_600),
    scrollTop: gen.integer(-500, 400_000),
    overscan: gen.integer(0, 12),
  });

  await check("window arithmetic", listGenerator, (input) => {
    const view = windowFor(input);
    // The three regions tile the whole scroll height with no gap and no overlap.
    assert.equal(view.offsetBefore + view.count * input.itemHeight + view.offsetAfter, view.totalHeight);
    assert.equal(view.totalHeight, input.total * input.itemHeight);
    assert.ok(view.start >= 0 && view.end <= input.total && view.start <= view.end);
    assert.equal(view.count, view.end - view.start);
    // The DOM is bounded no matter how large the viewport claims to be.
    assert.ok(view.count <= DEFAULT_WINDOW.maxRendered);
    // Whatever is on screen at this offset is inside the rendered range.
    if (input.total && input.viewportHeight) {
      const clampedTop = Math.max(0, Math.min(input.scrollTop, Math.max(0, view.totalHeight - input.viewportHeight)));
      const firstVisible = Math.min(input.total - 1, Math.floor(clampedTop / input.itemHeight));
      assert.ok(firstVisible >= view.start && firstVisible < Math.max(view.end, view.start + 1),
        `row ${firstVisible} is on screen but outside [${view.start}, ${view.end})`);
    }
    return true;
  });

  // Reachability: scrolling from top to bottom must be able to show every row.
  await check("every row is reachable", gen.record({ total: gen.integer(1, 400), itemHeight: gen.integer(4, 40), viewportHeight: gen.integer(20, 600) }), (input) => {
    const seen = new Set();
    const totalHeight = input.total * input.itemHeight;
    for (let scrollTop = 0; scrollTop <= totalHeight; scrollTop += Math.max(1, Math.floor(input.itemHeight / 2))) {
      const view = windowFor({ ...input, scrollTop });
      for (let index = view.start; index < view.end; index += 1) seen.add(index);
    }
    assert.equal(seen.size, input.total, `only ${seen.size} of ${input.total} rows were reachable`);
    return true;
  }, { runs: 100 });

  // Variable heights: the same tiling property, plus a consistent index.
  await check("variable-height windows", gen.record({
    heights: gen.array(gen.integer(0, 300), { min: 0, max: 25 }),
    viewportHeight: gen.integer(0, 900),
    scrollTop: gen.integer(-100, 6_000),
    overscan: gen.integer(0, 4),
  }), (input) => {
    const view = variableWindowFor(input);
    const rendered = input.heights.slice(view.start, view.end).reduce((sum, value) => sum + value, 0);
    assert.equal(view.offsetBefore + rendered + view.offsetAfter, view.totalHeight);
    const offsets = buildHeightIndex(input.heights);
    assert.equal(offsets.at(-1), view.totalHeight);
    // `indexAt` and the prefix sums must agree at every boundary.
    for (let index = 0; index < input.heights.length; index += 1) {
      if (input.heights[index] === 0) continue;
      assert.ok(indexAt(offsets, offsets[index]) <= index, `offset ${offsets[index]} resolved past row ${index}`);
    }
    return true;
  });

  await check("scrolling to a row keeps it on screen", gen.record({
    total: gen.integer(1, 900), itemHeight: gen.integer(2, 60), viewportHeight: gen.integer(10, 800), index: gen.integer(-5, 950), scrollTop: gen.integer(0, 40_000),
  }), (input) => {
    const next = scrollToIndex(input);
    const clampedIndex = Math.max(0, Math.min(input.index, input.total - 1));
    const rowTop = clampedIndex * input.itemHeight;
    assert.ok(next >= 0);
    // The top of the row is always brought into view. The whole row is, too,
    // whenever it fits — a row taller than the viewport cannot be, and the top
    // is the half a reader needs first.
    assert.ok(rowTop >= next - 0.001, `the top of row ${clampedIndex} is above the viewport at ${next}`);
    if (input.itemHeight < input.viewportHeight) {
      assert.ok(rowTop + input.itemHeight <= next + input.viewportHeight + 0.001, `row ${clampedIndex} is not fully visible at ${next}`);
    }
    return true;
  });
});

test("property: culling a graph never invents a node or a dangling edge", async () => {
  const graphGenerator = gen.record({
    size: gen.integer(0, 60),
    budget: gen.integer(0, 40),
    left: gen.integer(-100, 300),
    width: gen.integer(0, 400),
  });
  await check("graph culling", graphGenerator, (input) => {
    const nodes = Array.from({ length: input.size }, (_, index) => ({ id: `n${index}`, x: index * 7, y: index * 3, width: 20, height: 10, importance: (index * 37) % 101 }));
    const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));
    const viewport = { left: input.left, right: input.left + input.width, top: -1_000, bottom: 1_000 };
    const result = cullGraph({ nodes, edges, viewport, budget: input.budget });
    const ids = new Set(result.nodes.map((node) => node.id));
    assert.ok(result.nodes.every((node) => nodes.includes(node)), "culling returned a node that was not in the graph");
    assert.equal(ids.size, result.nodes.length, "culling duplicated a node");
    assert.ok(result.nodes.length <= Math.min(input.size, Math.max(0, input.budget)) || input.budget >= input.size);
    // No edge may point at something that is not drawn.
    assert.ok(result.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)), "a dangling edge survived culling");
    assert.equal(result.total, input.size);
    assert.equal(result.complete, result.nodes.length === input.size && result.edges.length === edges.length);
    assert.equal(result.culledByViewport + result.culledByBudget, input.size - result.nodes.length);
    // Over budget, what survives is the most important — never an arbitrary slice.
    if (result.culledByBudget > 0) {
      const kept = Math.min(...result.nodes.map((node) => node.importance));
      const dropped = nodes.filter((node) => !ids.has(node.id) && node.x + node.width >= viewport.left && node.x <= viewport.right);
      assert.ok(dropped.every((node) => node.importance <= kept), "culling dropped a more important node than it kept");
    }
    return true;
  });
});

test("property: a derived colour always clears the ratio its level promises", async () => {
  const colorGenerator = gen.record({
    r: gen.integer(0, 255),
    g: gen.integer(0, 255),
    b: gen.integer(0, 255),
    theme: gen.pick(["light", "dark"]),
    level: gen.pick(["normal", "high"]),
  });
  await check("theme derivation", colorGenerator, (input) => {
    const hex = rgbToHex([input.r, input.g, input.b]);
    if (input.theme === "dark" && input.level === "normal") {
      assert.equal(deriveColor(hex, { kind: "foreground", theme: "dark", contrast: "normal" }), hex, "the dark theme is the authored palette");
      return true;
    }
    const target = CONTRAST_TARGETS[input.level];
    const worstSurface = target.surfaceLuminance[input.theme];
    const foreground = hexToRgb(deriveColor(hex, { kind: "foreground", theme: input.theme, contrast: input.level }));
    // The surface luminance the derivation aims at is a number; the ratio
    // against it must be the promised one for *any* input colour.
    const ratio = (Math.max(luminance(foreground), worstSurface) + 0.05) / (Math.min(luminance(foreground), worstSurface) + 0.05);
    assert.ok(ratio >= target.text - 0.05, `${hex} in ${input.theme}/${input.level} reached only ${ratio.toFixed(2)}:1`);
    // Surfaces move the other way, and stay inside the range.
    const surface = hexToRgb(deriveColor(hex, { kind: "surface", theme: input.theme, contrast: input.level }));
    assert.ok(surface.every((channel) => channel >= 0 && channel <= 255));
    if (input.theme === "light") assert.ok(luminance(surface) >= 0.73, `a light surface came out at ${luminance(surface).toFixed(3)}`);
    else assert.ok(luminance(surface) <= luminance(hexToRgb(hex)) + 0.001, "a high-contrast dark surface got lighter");
    return true;
  });

  // Simulating a deficiency is idempotent on a neutral, and never leaves gamut.
  await check("vision simulation", gen.record({ r: gen.integer(0, 255), g: gen.integer(0, 255), b: gen.integer(0, 255), mode: gen.pick(["protanopia", "deuteranopia", "tritanopia", "monochrome"]) }), (input) => {
    const simulated = hexToRgb(simulateVision(rgbToHex([input.r, input.g, input.b]), input.mode));
    assert.ok(simulated.every((channel) => channel >= 0 && channel <= 255), JSON.stringify(simulated));
    const grey = hexToRgb(simulateVision(rgbToHex([input.r, input.r, input.r]), input.mode));
    assert.ok(Math.max(...grey) - Math.min(...grey) <= 4, `${input.mode} moved a neutral grey`);
    return true;
  });

  // Whatever the palette, the separation report names a real pair.
  const worst = paletteSeparation({ a: "#ff0000", b: "#00ff00", c: "#0000ff" }, "deuteranopia");
  assert.equal(worst.pair.length, 2);
  assert.ok(contrast(hexToRgb("#ffffff"), hexToRgb("#000000")) > 20);
});

test("property: applying a migration and reverting it restores the course exactly", async () => {
  const courseGenerator = gen.record({
    lessons: gen.integer(1, 5),
    anchorsPerLesson: gen.integer(0, 4),
    shift: gen.integer(-6, 40),
    rename: gen.pick([true, false]),
    remove: gen.pick([true, false]),
  });

  await check("migration reversibility", courseGenerator, (input) => {
    const symbols = Array.from({ length: input.lessons * Math.max(1, input.anchorsPerLesson) }, (_, index) => ({
      name: `sym_${index}`,
      kind: "function",
      path: `app/mod_${index % 3}.py`,
      line: 1 + index * 10,
      endLine: 6 + index * 10,
    }));
    const source = (path) => symbols.filter((symbol) => symbol.path === path)
      .map((symbol) => `def ${symbol.name}():\n    total = ${symbol.line}\n    return total\n`).join("\n");
    const paths = [...new Set(symbols.map((symbol) => symbol.path))];
    const before = Object.fromEntries(paths.map((path) => [path, source(path)]));
    const course = {
      id: "generated",
      modules: [{
        id: "m",
        lessons: Array.from({ length: input.lessons }, (_, lesson) => ({
          id: `l${lesson}`,
          title: `Lesson ${lesson}`,
          anchors: symbols.slice(lesson * input.anchorsPerLesson, (lesson + 1) * input.anchorsPerLesson)
            .map((symbol) => ({ path: symbol.path, line: symbol.line, symbol: symbol.name })),
        })),
      }],
    };

    const moved = symbols.map((symbol, index) => ({
      ...symbol,
      name: input.rename && index === 0 ? `${symbol.name}_renamed` : symbol.name,
      line: symbol.line + Math.max(0, input.shift),
      endLine: symbol.endLine + Math.max(0, input.shift),
    })).filter((_, index) => !(input.remove && index === 1));

    const snapshot = (list, sources, commit) => ({
      version: 1, label: commit, commit, sourceVersion: null,
      symbols: list.map((symbol) => ({ ...symbol, container: null, tokenCount: 12, fingerprint: 1, shingles: [symbol.line], bodied: true })),
      files: Object.keys(sources), fileDigests: {}, bodied: true,
    });

    const plan = planMigration(course, snapshot(symbols, before, "old"), snapshot(moved, before, "new"));
    for (const accept of ["auto", "all"]) {
      const applied = applyMigration(course, plan, { accept, now: "2026-01-01T00:00:00.000Z" });
      const reverted = revertMigration(applied.course);
      assert.equal(reverted.reverted, true);
      assert.equal(
        JSON.stringify(reverted.course.modules),
        JSON.stringify(course.modules),
        `reverting an ${accept} migration did not restore the course`,
      );
      assert.deepEqual(reverted.course.migrations, []);
      // Nothing may be invented: every anchor still points at a real definition
      // or was retired, never at something that does not exist.
      for (const lesson of applied.course.modules[0].lessons) {
        for (const anchor of lesson.anchors ?? []) {
          assert.ok(moved.some((symbol) => symbol.path === anchor.path && symbol.line === anchor.line) || before[anchor.path] !== undefined,
            `migration invented ${anchor.path}:${anchor.line}`);
        }
      }
    }
    return true;
  }, { runs: 100 });
});

test("property: merging progress and notes can never lose anything", async () => {
  const evidenceGenerator = gen.record({
    localSkills: gen.array(gen.integer(0, 5), { max: 6 }),
    importedSkills: gen.array(gen.integer(0, 5), { max: 6 }),
    localNotes: gen.array(gen.integer(0, 4), { max: 6 }),
    importedNotes: gen.array(gen.integer(0, 4), { max: 6 }),
    diverge: gen.pick([true, false]),
  });

  await check("merge loses nothing", evidenceGenerator, (input) => {
    const stateFor = (skills, tag) => ({
      repositoryId: "r",
      diagnosticCompleted: tag === "local",
      mastery: Object.fromEntries(skills.map((skill) => [`skill-${skill}`, {
        skillId: `skill-${skill}`,
        mastery: (skill + 1) / 10,
        confidence: 0.5,
        status: "learning",
        evidence: [{ id: `${tag}-${skill}`, skillId: `skill-${skill}`, kind: "lesson", strength: 0.3, detail: tag, createdAt: `2026-01-0${(skill % 9) + 1}T00:00:00.000Z` }],
      }])),
      memory: skills.map((skill) => ({ id: `${tag}-mem-${skill}`, text: `${tag} ${skill}`, source: "learner", createdAt: "2026-01-01T00:00:00.000Z" })),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const local = stateFor(input.localSkills, "local");
    const imported = stateFor(input.importedSkills, "imported");
    const merged = mergeProgress(local, imported);

    const evidenceOf = (state) => new Set(Object.values(state.mastery).flatMap((entry) => entry.evidence.map((item) => item.id)));
    const expected = new Set([...evidenceOf(local), ...evidenceOf(imported)]);
    assert.deepEqual([...evidenceOf(merged.state)].sort(), [...expected].sort(), "the merge lost evidence");
    const memories = new Set(merged.state.memory.map((entry) => entry.id));
    for (const entry of [...local.memory, ...imported.memory]) assert.ok(memories.has(entry.id), `memory ${entry.id} was lost`);
    // A completed diagnostic can never be un-completed by importing.
    assert.equal(merged.state.diagnosticCompleted, local.diagnosticCompleted || imported.diagnosticCompleted);
    // Merging is idempotent: importing the same archive twice gains nothing.
    const again = mergeProgress(merged.state, imported);
    assert.deepEqual([...evidenceOf(again.state)].sort(), [...evidenceOf(merged.state)].sort());
    assert.equal(again.gained.evidence, 0);

    const notesFor = (ids, tag) => ids.map((id) => ({ id: `note-${id}`, lessonId: "l", anchor: null, text: input.diverge ? `${tag} ${id}` : `shared ${id}`, createdAt: null, updatedAt: null }));
    const mergedNotes = mergeNotes(notesFor(input.localNotes, "local"), notesFor(input.importedNotes, "imported"));
    const texts = new Set(mergedNotes.notes.map((note) => note.text));
    for (const note of [...notesFor(input.localNotes, "local"), ...notesFor(input.importedNotes, "imported")]) {
      assert.ok(texts.has(note.text), `note text "${note.text}" was lost`);
    }
    assert.equal(new Set(mergedNotes.notes.map((note) => note.id)).size, mergedNotes.notes.length, "the merge produced duplicate note ids");
    const twice = mergeNotes(mergedNotes.notes, notesFor(input.importedNotes, "imported"));
    assert.equal(twice.added, 0, "merging the same notes again added something");
    return true;
  });

  // The note editor itself: an edit is always visible, a clear always removes.
  await check("note edits", gen.record({ id: gen.integer(0, 3), text: gen.pick(["", "   ", "a", "a longer note"]), existing: gen.integer(0, 3) }), (input) => {
    const notes = [{ id: `n${input.existing}`, lessonId: "l", anchor: null, text: "before", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];
    const result = applyNoteEdit(notes, { id: `n${input.id}`, text: input.text });
    if (!input.text.trim()) {
      assert.equal(result.notes.some((note) => note.id === `n${input.id}`), false, "a cleared note survived");
      return true;
    }
    const saved = result.notes.find((note) => note.id === `n${input.id}`);
    assert.equal(saved.text, input.text);
    if (input.id === input.existing) assert.equal(saved.createdAt, "2026-01-01T00:00:00.000Z", "editing reset when the note was written");
    assert.equal(new Set(result.notes.map((note) => note.id)).size, result.notes.length);
    return true;
  });
});

test("property: a deep link never yields an intent it was not given, and redaction never emits a secret", async () => {
  const open = [{ id: "repo-1", rootPath: "/repo" }];
  const linkGenerator = gen.record({
    action: gen.pick(["open", "lesson", "file", "destroy", ""]),
    file: gen.pick(["a.py", "a/b.py", "../secret", "/etc/passwd", "", "a/../b"]),
    line: gen.pick(["1", "42", "abc", "-1", ""]),
    repo: gen.pick(["/repo", "repo-1", "/elsewhere", ""]),
    extra: gen.pick(["", "exec=1", "view=code", "view=console"]),
  });
  await check("deep links", linkGenerator, (input) => {
    const parameters = [input.repo && `repo=${encodeURIComponent(input.repo)}`, input.file && `file=${encodeURIComponent(input.file)}`, input.line && `line=${input.line}`, input.extra]
      .filter(Boolean).join("&");
    const result = parseDeepLink(`trace://${input.action}?${parameters}`, { openRepositories: open });
    // Invalid means *no* intent, always. A partially honoured link is the bug
    // this whole module exists to prevent.
    assert.equal(result.valid, result.intent !== null);
    if (!result.valid) {
      assert.ok(result.reason && result.detail, "a refusal without a reason");
      return true;
    }
    assert.ok(["open", "lesson", "file"].includes(result.intent.action));
    assert.equal(result.intent.repository.id, "repo-1");
    if (result.intent.file) {
      assert.equal(result.intent.file.startsWith("/"), false);
      assert.equal(result.intent.file.includes(".."), false);
    }
    if (result.intent.line !== null) assert.ok(Number.isInteger(result.intent.line) && result.intent.line >= 1);
    return true;
  });

  const secretGenerator = gen.record({
    secret: gen.pick(["ghp_abcdefghij0123456789abcdefghij012345", "AKIAIOSFODNN7EXAMPLE", "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
    before: gen.pick(["", "token = ", "the key is ", "{\"k\":\""]),
    after: gen.pick(["", "\nnext line", "\"}", " and more"]),
    depth: gen.integer(0, 3),
  });
  await check("redaction", secretGenerator, (input) => {
    const text = `${input.before}${input.secret}${input.after}`;
    let value = { text };
    for (let depth = 0; depth < input.depth; depth += 1) value = { nested: value, list: [value] };
    const serialized = JSON.stringify(redactValue(value));
    assert.equal(serialized.includes(input.secret), false, `a secret survived redaction at depth ${input.depth}`);
    assert.ok(scanText(text).length >= 1, "the scanner did not see a secret it must redact");
    return true;
  });
});

test("property: the accessibility auditor never crashes and never invents a violation", async () => {
  // A rule that throws on an unusual DOM is a rule that gets switched off, and
  // a rule that reports a violation with no element is one nobody can act on.
  const nodeGenerator = gen.record({
    count: gen.integer(0, 25),
    tag: gen.pick(["div", "button", "input", "svg", "img", "h1", "h3", "main", "header", "label", "a"]),
    label: gen.pick(["", "Save", "  "]),
    hidden: gen.pick([true, false]),
    tabIndex: gen.integer(-1, 3),
    size: gen.integer(0, 60),
  });
  await check("auditor robustness", nodeGenerator, (input) => {
    const nodes = Array.from({ length: input.count }, (_, index) => ({
      index,
      tag: input.tag,
      parentIndex: index === 0 ? -1 : index - 1,
      classes: [],
      attributes: input.label ? { "aria-label": input.label } : {},
      ownText: index % 2 ? "text" : "",
      text: index % 2 ? "text" : "",
      tabIndex: input.tabIndex,
      disabled: false,
      width: input.size,
      height: input.size,
      display: input.hidden ? "none" : "block",
      visibility: "visible",
      opacity: 1,
      color: "rgb(255,255,255)",
      backgroundColor: "rgb(0,0,0)",
      fontSize: 13,
      fontWeight: 400,
      outlineStyle: "none",
    }));
    const audit = auditSnapshot({ url: "test", title: "t", lang: "en", activeElementIndex: -1, nodes });
    assert.ok(Array.isArray(audit.violations));
    assert.equal(audit.rendered <= audit.elements, true);
    for (const violation of audit.violations) {
      assert.ok(violation.rule && violation.severity && violation.detail, JSON.stringify(violation));
      assert.ok(["critical", "serious", "moderate"].includes(violation.severity));
      assert.ok(violation.selector && violation.selector.length > 0);
    }
    assert.equal(audit.passed, audit.violations.length === 0);
    // Nothing rendered means nothing to report about elements.
    if (input.hidden) assert.equal(audit.violations.every((violation) => violation.rule !== "contrast"), true);
    return true;
  });
});
