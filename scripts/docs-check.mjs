import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { IPC_SCHEMAS } from "../electron/ipc-schema.mjs";
import { SIGNABLE_SUBJECTS } from "../electron/signing.mjs";
import { PLUGIN_CAPABILITIES, PLUGIN_KINDS } from "../electron/plugins.mjs";
import { budgetIds } from "../electron/performance.mjs";

/**
 * Keep the documentation honest (item 59).
 *
 * The failure mode of a threat model, a privacy statement, or an extension
 * contract is not that it is badly written. It is that it was true once. Six
 * months later there are four new IPC channels, a new signing subject, and a
 * directory nobody mentioned, and the document is now a *misleading* artifact
 * rather than merely an incomplete one — worse than having none, because people
 * believe it.
 *
 * So the documents are checked against the code they describe, in both
 * directions. Adding a channel without documenting it fails; leaving a line
 * behind for a channel that no longer exists also fails, because a contract
 * promising something that is gone is the same problem wearing the other face.
 *
 * The one thing this cannot check is whether the prose is *right*. It checks
 * that the prose is *complete* and *current*, which is the part that rots.
 */

/** Hosts a claim about learning may be cited from. */
export const RESEARCH_HOSTS = ["arxiv.org", "dl.acm.org", "doi.org", "link.springer.com", "psycnet.apa.org", "www.sciencedirect.com"];

export const DOCUMENTS = {
  threatModel: "docs/threat-model.md",
  privacy: "docs/privacy.md",
  pedagogy: "docs/pedagogy.md",
  extending: "docs/extending.md",
  plugins: "plugins/README.md",
};

/** Every directory the application writes under its user-data path. */
export function userDataDirectories(mainSource) {
  return [...new Set([...mainSource.matchAll(/getPath\("userData"\),\s*"([^"]+)"/g)].map((match) => match[1]))].sort();
}

/** Every module named as a control in the threat model's tables. */
export function citedModules(threatModelSource) {
  return [...new Set([...threatModelSource.matchAll(/`(electron\/[a-z-]+\.mjs)`/g)].map((match) => match[1]))].sort();
}

function missing(label, expected, text) {
  return expected.filter((item) => !text.includes(item)).map((item) => `${label}: ${item} is not documented`);
}

/**
 * A line in a bullet list that names something in backticks, so a stale entry
 * can be told apart from prose that happens to mention a channel.
 */
export function documentedItems(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort();
}

export async function checkDocumentation({ projectRoot = path.resolve(".") } = {}) {
  const read = async (relative) => readFile(path.join(projectRoot, relative), "utf8");
  const sources = {};
  const problems = [];
  for (const [key, relative] of Object.entries(DOCUMENTS)) {
    try {
      sources[key] = await read(relative);
    } catch {
      problems.push(`missing document: ${relative}`);
      sources[key] = "";
    }
  }

  const channels = Object.keys(IPC_SCHEMAS).sort();
  const documentedChannels = documentedItems(sources.extending, /^- `([a-z-]+:[a-z-]+)`/gm);
  problems.push(...missing("IPC channel", channels, sources.extending));
  // The other direction: a contract that promises a channel which no longer
  // exists is the same failure wearing the other face.
  for (const documented of documentedChannels) {
    if (!channels.includes(documented)) problems.push(`IPC channel: ${documented} is documented but no longer exists`);
  }

  problems.push(...missing("signing subject", SIGNABLE_SUBJECTS.map((subject) => `\`${subject}\``), sources.extending));
  problems.push(...missing("plugin kind", PLUGIN_KINDS.map((kind) => `\`${kind}\``), sources.extending));
  problems.push(...missing("plugin capability", Object.keys(PLUGIN_CAPABILITIES).map((capability) => `\`${capability}\``), sources.extending));
  problems.push(...missing("plugin capability", Object.keys(PLUGIN_CAPABILITIES), sources.plugins));
  problems.push(...missing("performance budget", budgetIds().map((id) => `\`${id}\``), sources.extending));

  // Every directory the application writes to must be inventoried, or the
  // privacy statement is describing a smaller application than the one shipped.
  const mainSource = await read("electron/main.mjs");
  const directories = userDataDirectories(mainSource);
  problems.push(...missing("user-data directory", directories.map((directory) => `\`${directory}\``), sources.privacy));

  // Every control the threat model claims must be a module that exists.
  const modules = new Set((await readdir(path.join(projectRoot, "electron"))).map((entry) => `electron/${entry}`));
  for (const cited of citedModules(sources.threatModel)) {
    if (!modules.has(cited)) problems.push(`threat model: cites ${cited}, which does not exist`);
  }

  // Nothing here may claim to be complete. Every document states what it does
  // not cover, because the documents that get people hurt are the confident
  // ones.
  for (const [key, relative] of Object.entries(DOCUMENTS)) {
    if (key === "plugins") {
      if (!/Stated limitation/i.test(sources[key])) problems.push(`${relative}: states no limitation`);
      continue;
    }
    if (!/^#+ (Residual risks|Limits, stated plainly|Stability)/m.test(sources[key])) {
      problems.push(`${relative}: has no section stating what it does not cover`);
    }
  }

  // The pedagogy document's claims must rest on something citable. Anybody can
  // link a blog post, so the check is for *research* hosts specifically: this
  // is the one document in the set whose content is a claim about people rather
  // than about this code, and it is the one where sounding plausible is
  // cheapest.
  const research = [...sources.pedagogy.matchAll(/\[[^\]]+\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1]);
  const scholarly = research.filter((url) => RESEARCH_HOSTS.some((host) => {
    try {
      return new URL(url).host === host;
    } catch {
      return false;
    }
  }));
  if (scholarly.length < 3) problems.push(`pedagogy: fewer than three research citations (found ${scholarly.length})`);

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      channels: channels.length,
      documentedChannels: documentedChannels.length,
      signingSubjects: SIGNABLE_SUBJECTS.length,
      pluginKinds: PLUGIN_KINDS.length,
      pluginCapabilities: Object.keys(PLUGIN_CAPABILITIES).length,
      budgets: budgetIds().length,
      userDataDirectories: directories.length,
      citedModules: citedModules(sources.threatModel).length,
    },
    userDataDirectories: directories,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await checkDocumentation();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`${result.problems.length} documentation problem(s).`);
    process.exitCode = 1;
  }
}
