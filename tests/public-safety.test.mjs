import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanPublicTree } from "../scripts/public-safety.mjs";

test("detects machine paths, personal initials, credential filenames, and credential shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-public-safety-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "src", "bad.txt"),
      `${["/Users", "private", "repo"].join("/")}\n${["B", "J"].join("")}`,
    );
    await writeFile(
      path.join(root, ".env.production"),
      `KEY=${["ghp", "x".repeat(36)].join("_")}`,
    );

    const violations = await scanPublicTree(root);

    assert.deepEqual(
      new Set(violations.map((item) => item.rule)),
      new Set([
        "absolute-home-path",
        "personal-initials",
        "credential-file",
        "github-token",
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows explicit public and synthetic fixtures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-public-allow-"));
  try {
    await writeFile(
      path.join(root, ".env.example"),
      "TRACE_URL=http://127.0.0.1:5173\n",
    );
    await writeFile(
      path.join(root, "fixture.txt"),
      "trace@example.com\n/tmp/trace-practice/example\n",
    );

    assert.deepEqual(await scanPublicTree(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects user-supplied identity terms in content and paths without false-positive substrings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-public-identities-"));
  const sensitiveTerms = [
    ["b", ["j", "in"].join("")].join(""),
    ["nvi", "dia"].join(""),
    ["zheng", "hui"].join(""),
    ["j", "in"].join(""),
  ];
  try {
    for (const [index, term] of sensitiveTerms.entries()) {
      const directory = path.join(root, `private-${term}`);
      await mkdir(directory);
      await writeFile(
        path.join(directory, `record-${index}.txt`),
        `${term}\n${term.toUpperCase()}\n`,
      );
    }
    await writeFile(
      path.join(root, "allowed-substrings.txt"),
      "jingle jinja origin engine\n",
    );

    const violations = await scanPublicTree(root);
    const identityViolations = violations.filter((item) =>
      item.rule.startsWith("sensitive-identity-"),
    );

    assert.ok(
      identityViolations.filter((item) => item.rule === "sensitive-identity-content").length >= 8,
    );
    assert.equal(
      identityViolations.filter((item) => item.rule === "sensitive-identity-path").length,
      4,
    );
    assert.equal(
      identityViolations.some((item) => item.path === "allowed-substrings.txt"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Trace release tree contains no public-safety violations", async () => {
  assert.deepEqual(await scanPublicTree(path.resolve(".")), []);
});
