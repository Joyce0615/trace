import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalize, signPayload, verifyPayload } from "./signing.mjs";
import { compareVersions } from "./updates.mjs";

/**
 * Software bills of materials, dependency scanning, provenance, and the
 * reproducibility check that makes any of it worth reading (item 56).
 *
 * Items 45 and 55 sealed what this project *produces*: a course package, an
 * update manifest, a release payload. None of that says anything about what
 * goes *in*. The application is roughly thirty thousand lines of first-party
 * code sitting on top of two hundred and seventy-odd packages that were
 * downloaded from a registry, and every one of them runs with the same
 * privileges as `main.mjs`. A signature over the build says "this is the build
 * we made"; it does not say what the build was made of.
 *
 * Four things are needed, and each of them is easy to fake:
 *
 *   - **A bill of materials** that is derived from the lockfile and the
 *     directory on disk, not written by hand. A hand-written SBOM is a document
 *     that describes what somebody believed at the time.
 *   - **A scan** that is honest about its own coverage. The failure mode that
 *     matters is not "misses a vulnerability" but "reports zero
 *     vulnerabilities because it had no advisory feed". `scanDependencies`
 *     returns `vulnerabilities: null` — not an empty array — when no feed was
 *     supplied, and `describeScan` says so in words.
 *   - **Provenance** that binds the artifact's digest to the materials it was
 *     built from, signed under its own subject so it cannot be lifted from an
 *     update manifest.
 *   - **Reproducibility**, because provenance is unfalsifiable only if a third
 *     party can rebuild the artifact and get the same bytes. Everything here is
 *     therefore free of wall-clock time and of iteration order: the SBOM's
 *     serial number is derived from its own content rather than being a random
 *     UUID, and there is no `metadata.timestamp`, which is the field that
 *     silently makes every CycloneDX document unique.
 *
 * Node is used for hashing and for reading the tree; nothing here reaches the
 * network. A scanner that needed the network to say "clean" would be offline
 * exactly when it mattered.
 */

export const SUPPLY_CHAIN_VERSION = 1;
export const SBOM_FORMAT = "CycloneDX";
export const SBOM_SPEC_VERSION = "1.5";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const BUILD_TYPE = "https://github.com/codebase-learning-studio/build/npm-release/v1";

/** Registries a resolved tarball may legitimately have come from. */
export const TRUSTED_REGISTRIES = ["registry.npmjs.org"];

export const FINDING_SEVERITIES = ["critical", "high", "moderate", "low", "info"];

/**
 * The license policy, expressed as three lists rather than one allow list.
 *
 * "Review" is the important category and the one usually missing. MPL-2.0 and
 * CC-BY-4.0 are not a legal problem for a desktop application that ships them
 * unmodified, and they are not the same thing as MIT either: they carry
 * obligations that a human has to decide about once. Collapsing them into
 * "allowed" hides the decision; collapsing them into "denied" makes the scan
 * something people learn to override.
 */
export const DEFAULT_LICENSE_POLICY = {
  allowed: ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "Unlicense", "CC0-1.0", "Python-2.0"],
  review: ["MPL-2.0", "CC-BY-4.0", "EPL-2.0", "LGPL-2.1", "LGPL-3.0", "CDDL-1.0"],
  denied: ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "SSPL-1.0", "BUSL-1.1", "Commons Clause"],
};

// ---------------------------------------------------------------------------
// Version ranges
// ---------------------------------------------------------------------------

/**
 * Does `version` fall inside `range`?
 *
 * Advisory feeds state affected versions as npm ranges, so matching one is not
 * optional and cannot be done with string equality. Supported: `*`, exact
 * versions, `=`, `>`, `>=`, `<`, `<=`, `~`, `^`, `x`/`*` wildcards in a
 * position, hyphen ranges (`1.2.3 - 2.0.0`), space- or comma-separated
 * conjunctions, and `||` disjunctions.
 *
 * `includePrerelease` defaults to **true**, which is deliberately the opposite
 * of what npm's installer does. npm excludes pre-releases so that `^1.0.0` does
 * not silently install `2.0.0-beta`; that reasoning is about what you would
 * *choose* to install. An advisory is a statement about what is broken, and
 * `1.4.0-rc.1` of a package whose `<1.4.2` versions are vulnerable is
 * vulnerable. Getting this backwards makes a scanner quietly clear exactly the
 * builds most likely to be affected.
 */
export function satisfiesRange(version, range, { includePrerelease = true } = {}) {
  const text = String(range ?? "").trim();
  if (!text || text === "*" || text === "x" || text === "latest") return true;
  if (!parseSemver(version)) return false;
  return text.split("||").some((alternative) => satisfiesConjunction(version, alternative, includePrerelease));
}

function parseSemver(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    pre: match[4] ?? "",
  };
}

function coreOf(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function satisfiesConjunction(version, alternative, includePrerelease) {
  const tokens = alternative.trim().split(/[\s,]+/).filter(Boolean);
  const comparators = [];
  for (let index = 0; index < tokens.length; index += 1) {
    // A hyphen range is three tokens, and must be read before the bare
    // versions on either side are mistaken for exact matches.
    if (tokens[index + 1] === "-" && tokens[index + 2]) {
      comparators.push({ operator: ">=", value: tokens[index] }, { operator: "<=", value: tokens[index + 2] });
      index += 2;
      continue;
    }
    comparators.push(...expandComparator(tokens[index]));
  }
  if (!comparators.length) return true;
  if (!comparators.every((comparator) => compareOne(version, comparator))) return false;
  if (includePrerelease) return true;
  // Standard semver: a pre-release only satisfies a range that itself names a
  // pre-release at the same major.minor.patch.
  const parsed = parseSemver(version);
  if (!parsed.pre) return true;
  return comparators.some((comparator) => {
    const bound = parseSemver(comparator.value);
    return bound && bound.pre && coreOf(bound) === coreOf(parsed);
  });
}

function expandComparator(token) {
  if (!token || token === "*" || token === "x" || token === "X") return [];
  const caret = /^\^\s*(.+)$/.exec(token);
  if (caret) {
    const parsed = parseSemver(caret[1]);
    if (!parsed) return [{ operator: "impossible", value: token }];
    // ^0.x is narrower than ^1.x, because before 1.0.0 the minor is the
    // breaking-change position.
    const upper = parsed.major > 0
      ? `${parsed.major + 1}.0.0`
      : parsed.minor > 0 ? `0.${parsed.minor + 1}.0` : `0.0.${parsed.patch + 1}`;
    return [{ operator: ">=", value: caret[1] }, { operator: "<", value: upper }];
  }
  const tilde = /^~\s*(.+)$/.exec(token);
  if (tilde) {
    const parsed = parseSemver(tilde[1]);
    if (!parsed) return [{ operator: "impossible", value: token }];
    return [{ operator: ">=", value: tilde[1] }, { operator: "<", value: `${parsed.major}.${parsed.minor + 1}.0` }];
  }
  const operatorMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(token);
  if (operatorMatch) return [{ operator: operatorMatch[1], value: operatorMatch[2] }];
  // A wildcard in a position — `1.2.x` — is a range, not an exact version.
  const wildcard = /^(\d+)(?:\.(\d+))?\.(?:x|X|\*)$/.exec(token);
  if (wildcard) {
    const major = Number(wildcard[1]);
    if (wildcard[2] === undefined) return [{ operator: ">=", value: `${major}.0.0` }, { operator: "<", value: `${major + 1}.0.0` }];
    const minor = Number(wildcard[2]);
    return [{ operator: ">=", value: `${major}.${minor}.0` }, { operator: "<", value: `${major}.${minor + 1}.0` }];
  }
  if (/^(\d+)\.(?:x|X|\*)$/.test(token)) {
    const major = Number(token.split(".")[0]);
    return [{ operator: ">=", value: `${major}.0.0` }, { operator: "<", value: `${major + 1}.0.0` }];
  }
  // A bare partial version is a range, not an exact match: npm reads `1.2` as
  // `1.2.x`, and treating it as `=1.2.0` would clear every patch release of a
  // version an advisory actually names.
  const partial = /^(\d+)(?:\.(\d+))?$/.exec(token);
  if (partial) {
    const major = Number(partial[1]);
    if (partial[2] === undefined) return [{ operator: ">=", value: `${major}.0.0` }, { operator: "<", value: `${major + 1}.0.0` }];
    const minor = Number(partial[2]);
    return [{ operator: ">=", value: `${major}.${minor}.0` }, { operator: "<", value: `${major}.${minor + 1}.0` }];
  }
  return [{ operator: "=", value: token }];
}

function compareOne(version, comparator) {
  if (comparator.operator === "impossible") return false;
  if (!parseSemver(comparator.value)) return false;
  const order = compareVersions(version, comparator.value);
  switch (comparator.operator) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    default: return order === 0;
  }
}

// ---------------------------------------------------------------------------
// Bill of materials
// ---------------------------------------------------------------------------

/** `pkg:npm/@scope%2Fname@version`, the identifier every SBOM consumer keys on. */
export function purlFor(name, version) {
  const [scope, bare] = String(name).startsWith("@") ? String(name).slice(1).split("/", 2) : [null, String(name)];
  const encoded = scope ? `%40${encodeURIComponent(scope)}%2F${encodeURIComponent(bare)}` : encodeURIComponent(bare);
  return `pkg:npm/${encoded}@${encodeURIComponent(version ?? "")}`;
}

/** `sha512-<base64>` from a lockfile becomes a CycloneDX hex hash. */
export function hashesFromIntegrity(integrity) {
  const hashes = [];
  for (const entry of String(integrity ?? "").split(/\s+/).filter(Boolean)) {
    const [algorithm, encoded] = entry.split("-", 2);
    if (!encoded) continue;
    const alg = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1", md5: "MD5" }[algorithm.toLowerCase()];
    if (!alg) continue;
    hashes.push({ alg, content: Buffer.from(encoded, "base64").toString("hex") });
  }
  return hashes;
}

function packageNameFor(installPath, declared) {
  if (declared) return declared;
  const marker = "node_modules/";
  const at = installPath.lastIndexOf(marker);
  return at === -1 ? installPath : installPath.slice(at + marker.length);
}

/**
 * Which lockfile entry resolves `name` when required from `fromPath`.
 *
 * npm's resolution is "walk up the directory tree looking for
 * `node_modules/<name>`", and a dependency graph built without walking it is
 * wrong exactly where it matters: nested duplicate versions, which are how the
 * same package ends up in a tree twice at two different versions, only one of
 * which is patched.
 */
function resolveFrom(packages, fromPath, name) {
  const segments = fromPath ? fromPath.split("/") : [];
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join("/");
    const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    // Only directories that are themselves `node_modules` children can host a
    // nested tree, so skip the `node_modules` segments while walking up.
  }
  return null;
}

/**
 * Read one installed package's own `package.json` and top-level listing.
 *
 * The lockfile is a claim about what *should* be installed; this is what is.
 * The two disagreeing is a real and common condition — a hand-edited
 * `node_modules`, an interrupted install, a `file:` override — and it is
 * exactly the condition under which a signed build attests to the wrong thing.
 */
async function inspectInstalled(projectRoot, installPath) {
  const directory = path.join(projectRoot, installPath);
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    return { installed: false, installedVersion: null, lifecycleScripts: [], nativeBinaries: [] };
  }
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch {
    entries = [];
  }
  const scripts = manifest.scripts ?? {};
  return {
    installed: true,
    installedVersion: manifest.version ?? null,
    installedLicense: typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? null,
    // Anything that runs during `npm install` runs before a single test does.
    lifecycleScripts: ["preinstall", "install", "postinstall"].filter((hook) => typeof scripts[hook] === "string" && scripts[hook].trim()),
    // A prebuilt `.node` is machine code that no build step in this repository
    // produced and no reviewer read.
    nativeBinaries: entries.filter((entry) => entry.endsWith(".node")).sort(),
  };
}

/**
 * Build the bill of materials for the project at `projectRoot`.
 *
 * Derived entirely from `package-lock.json` plus the directory on disk. The
 * document is deterministic: components sorted by their bom-ref, no timestamp,
 * and a serial number that is a digest of the components rather than a random
 * UUID — so two runs on two machines produce the same bytes, which is the only
 * thing that makes "the SBOM in the release matches the source" checkable.
 */
export async function buildSbom({ projectRoot = path.resolve("."), inspectDisk = true } = {}) {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  let lockfile;
  try {
    lockfile = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {
    throw new Error("No package-lock.json: an SBOM built from package.json alone would describe ranges, not the versions actually installed.");
  }
  if (Number(lockfile.lockfileVersion) < 2) {
    throw new Error(`package-lock.json is lockfileVersion ${lockfile.lockfileVersion}; integrity hashes and the full tree need 2 or later.`);
  }

  const packages = lockfile.packages ?? {};
  const components = [];
  for (const installPath of Object.keys(packages).sort()) {
    if (!installPath) continue;
    const entry = packages[installPath];
    if (entry.link) continue;
    const name = packageNameFor(installPath, entry.name);
    const disk = inspectDisk ? await inspectInstalled(projectRoot, installPath) : { installed: null, installedVersion: null, lifecycleScripts: [], nativeBinaries: [] };
    components.push({
      "bom-ref": installPath,
      type: "library",
      name,
      version: entry.version ?? null,
      purl: purlFor(name, entry.version),
      licenses: entry.license ? [{ license: { id: entry.license } }] : [],
      hashes: hashesFromIntegrity(entry.integrity),
      scope: entry.dev ? "excluded" : "required",
      externalReferences: entry.resolved ? [{ type: "distribution", url: entry.resolved }] : [],
      properties: [
        { name: "npm:path", value: installPath },
        { name: "npm:dev", value: String(Boolean(entry.dev)) },
        { name: "npm:optional", value: String(Boolean(entry.optional)) },
        { name: "npm:hasInstallScript", value: String(Boolean(entry.hasInstallScript)) },
        { name: "npm:installed", value: String(disk.installed) },
        { name: "npm:installedVersion", value: String(disk.installedVersion ?? "") },
        { name: "npm:lifecycleScripts", value: disk.lifecycleScripts.join(",") },
        { name: "npm:nativeBinaries", value: disk.nativeBinaries.join(",") },
        { name: "npm:os", value: (entry.os ?? []).join(",") },
        { name: "npm:cpu", value: (entry.cpu ?? []).join(",") },
      ],
    });
  }

  const dependencies = [];
  const rootRefs = [];
  for (const [field, kind] of [["dependencies", "runtime"], ["devDependencies", "development"], ["optionalDependencies", "optional"]]) {
    for (const name of Object.keys(packages[""]?.[field] ?? {})) {
      const resolved = resolveFrom(packages, "", name);
      if (resolved) rootRefs.push({ ref: resolved, kind });
    }
  }
  dependencies.push({ ref: `${manifest.name}@${manifest.version}`, dependsOn: [...new Set(rootRefs.map((item) => item.ref))].sort() });
  for (const component of components) {
    const entry = packages[component["bom-ref"]];
    const children = new Set();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(entry?.[field] ?? {})) {
        const resolved = resolveFrom(packages, component["bom-ref"], name);
        if (resolved) children.add(resolved);
      }
    }
    dependencies.push({ ref: component["bom-ref"], dependsOn: [...children].sort() });
  }

  const bom = {
    bomFormat: SBOM_FORMAT,
    specVersion: SBOM_SPEC_VERSION,
    version: 1,
    metadata: {
      component: {
        "bom-ref": `${manifest.name}@${manifest.version}`,
        type: "application",
        name: manifest.name,
        version: manifest.version,
        purl: purlFor(manifest.name, manifest.version),
        description: manifest.description ?? null,
      },
      tools: [{ vendor: "codebase-learning-studio", name: "supply-chain", version: String(SUPPLY_CHAIN_VERSION) }],
      properties: [
        // Stated in the document, because "why has this SBOM no timestamp" is
        // the first question anybody sensible asks about it.
        { name: "trace:reproducible", value: "true" },
        { name: "trace:timestampOmitted", value: "a timestamp would make every build's SBOM differ, which is the property this document exists to support" },
        { name: "trace:lockfileVersion", value: String(lockfile.lockfileVersion) },
      ],
    },
    components,
    dependencies: dependencies.sort((left, right) => left.ref.localeCompare(right.ref)),
  };
  // The serial number is a function of the content. A random UUID here is the
  // single most common reason two SBOMs of the same tree do not compare equal.
  bom.serialNumber = `urn:uuid:${serialFrom(bom)}`;
  return bom;
}

function serialFrom(bom) {
  const digest = createHash("sha256").update(canonicalize({ metadata: bom.metadata, components: bom.components, dependencies: bom.dependencies })).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/** The digest an attestation refers to a bill of materials by. */
export function sbomDigest(bom) {
  return `sha256:${createHash("sha256").update(canonicalize(bom)).digest("hex")}`;
}

function propertyOf(component, name) {
  return (component.properties ?? []).find((property) => property.name === name)?.value ?? "";
}

/** The components that actually ship, as opposed to the ones that build. */
export function runtimeComponents(bom) {
  return (bom.components ?? []).filter((component) => propertyOf(component, "npm:dev") !== "true");
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Convert `npm audit --json` output into an advisory feed.
 *
 * The feed is an input rather than something this module invents. npm's audit
 * needs the network; a build machine without one still gets every check below
 * that does not need a feed, and is told plainly that the advisory half did not
 * run.
 */
export function importNpmAudit(report) {
  const advisories = [];
  for (const [name, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      // A string `via` is a transitive pointer at another package's advisory,
      // not an advisory itself; recording it would double-count.
      if (typeof via === "string") continue;
      advisories.push({
        id: via.source ? `npm:${via.source}` : `npm:${name}`,
        name: via.name ?? name,
        range: via.range ?? entry.range ?? "*",
        severity: FINDING_SEVERITIES.includes(via.severity) ? via.severity : "moderate",
        title: via.title ?? "Unnamed advisory",
        url: via.url ?? null,
        fixedIn: entry.fixAvailable && typeof entry.fixAvailable === "object" ? entry.fixAvailable.version ?? null : null,
      });
    }
  }
  const seen = new Set();
  const unique = advisories.filter((advisory) => {
    const key = `${advisory.id}|${advisory.name}|${advisory.range}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    source: "npm-audit",
    auditReportVersion: report?.auditReportVersion ?? null,
    advisories: unique.sort((left, right) => `${left.name}|${left.id}`.localeCompare(`${right.name}|${right.id}`)),
  };
}

function finding(id, severity, component, detail, remediation) {
  return {
    id,
    severity,
    component: component ? `${component.name}@${component.version}` : null,
    ref: component?.["bom-ref"] ?? null,
    detail,
    remediation,
  };
}

/**
 * Scan a bill of materials.
 *
 * The advisory match is one of eight checks, and the other seven need no feed
 * at all: they are properties of the tree that can be read off the lockfile and
 * the disk. That split is the point. A scanner that can only say something when
 * an advisory database is reachable is a scanner that says nothing on the day
 * the database is down.
 */
export function scanDependencies(bom, options = {}) {
  const policy = options.licensePolicy ?? DEFAULT_LICENSE_POLICY;
  const registries = options.trustedRegistries ?? TRUSTED_REGISTRIES;
  const feed = options.advisories ?? null;
  const scope = options.scope ?? "all";
  const components = scope === "runtime" ? runtimeComponents(bom) : (bom.components ?? []);
  const findings = [];

  for (const component of components) {
    const shipped = propertyOf(component, "npm:dev") !== "true";
    const optional = propertyOf(component, "npm:optional") === "true";
    const installed = propertyOf(component, "npm:installed");
    const installedVersion = propertyOf(component, "npm:installedVersion");

    // 1. Integrity. Without one there is nothing tying the name in the lockfile
    //    to the bytes that were unpacked.
    const strong = (component.hashes ?? []).filter((hash) => hash.alg === "SHA-512" || hash.alg === "SHA-256");
    if (!(component.hashes ?? []).length) {
      findings.push(finding("missing-integrity", shipped ? "high" : "moderate", component, "The lockfile records no integrity hash, so the downloaded bytes cannot be checked against anything.", "Re-resolve the dependency from a registry that publishes integrity metadata."));
    } else if (!strong.length) {
      findings.push(finding("weak-integrity", "moderate", component, `The only integrity hash is ${component.hashes.map((hash) => hash.alg).join(", ")}, which is not collision-resistant.`, "Regenerate the lockfile with a modern npm so a SHA-512 hash is recorded."));
    }

    // 2. Where it came from.
    const distribution = (component.externalReferences ?? []).find((reference) => reference.type === "distribution");
    if (!distribution) {
      findings.push(finding("no-distribution", "low", component, "No resolved URL is recorded, so the source of these bytes is unknown.", "Reinstall so the lockfile records where each package was fetched from."));
    } else {
      let host = null;
      try {
        host = new URL(distribution.url).host;
      } catch {
        host = null;
      }
      if (!host) {
        findings.push(finding("unparseable-distribution", "moderate", component, `The resolved URL ${distribution.url} is not a URL.`, "Reinstall from a registry."));
      } else if (!registries.includes(host)) {
        findings.push(finding("untrusted-registry", shipped ? "high" : "moderate", component, `Resolved from ${host}, which is not one of the trusted registries (${registries.join(", ")}).`, "Vendor the package or add the registry to the policy deliberately."));
      }
    }

    // 3. Code that runs at install time, before any test does.
    const lifecycle = propertyOf(component, "npm:lifecycleScripts").split(",").filter(Boolean);
    if (lifecycle.length) {
      findings.push(finding("install-script", "moderate", component, `Runs ${lifecycle.join(", ")} during npm install, with the privileges of whoever installs.`, "Install with --ignore-scripts and check what the script does."));
    } else if (propertyOf(component, "npm:hasInstallScript") === "true") {
      // The lockfile's flag comes from registry metadata and the tarball's own
      // manifest is what npm actually runs. When they disagree the flag is
      // stale, and treating it as authoritative means auditing scripts that do
      // not exist while missing ones that do.
      findings.push(finding("stale-install-script-flag", "info", component, "The lockfile flags an install script, but the installed package declares none; the flag is stale registry metadata.", "No action; noted so the flag is not mistaken for evidence."));
    }

    // 4. Machine code nobody in this repository built.
    const natives = propertyOf(component, "npm:nativeBinaries").split(",").filter(Boolean);
    if (natives.length) {
      findings.push(finding("prebuilt-native-binary", shipped ? "moderate" : "low", component, `Ships prebuilt native code (${natives.join(", ")}) that no build step here produced.`, "Confirm the binary's provenance, or build the package from source."));
    }

    // 5. Lockfile against disk.
    if (installed === "false") {
      if (!optional) findings.push(finding("not-installed", "high", component, "The lockfile requires this package but it is not on disk.", "Run npm ci so the tree matches the lockfile."));
      else findings.push(finding("optional-not-installed", "info", component, "An optional package for another platform is absent, which is expected on this one.", "No action."));
    } else if (installed === "true" && installedVersion && installedVersion !== component.version) {
      findings.push(finding("lockfile-drift", "high", component, `The lockfile says ${component.version}; the installed package is ${installedVersion}. A build attests to the lockfile and executes the disk.`, "Run npm ci to discard the drift."));
    }

    // 6. Licensing.
    const declared = component.licenses?.[0]?.license?.id ?? null;
    const identifiers = splitLicense(declared);
    if (!identifiers.length) {
      findings.push(finding("license-unknown", shipped ? "moderate" : "low", component, "No license identifier is recorded, so what may be done with this code is unknown.", "Read the package's LICENSE file and record the identifier."));
    } else if (identifiers.some((id) => policy.denied.includes(id)) && !identifiers.some((id) => policy.allowed.includes(id))) {
      findings.push(finding("license-denied", "high", component, `Licensed ${declared}, which the policy denies.`, "Replace the dependency or change the policy deliberately."));
    } else if (!identifiers.some((id) => policy.allowed.includes(id))) {
      const category = identifiers.some((id) => policy.review.includes(id)) ? "license-review" : "license-unrecognized";
      findings.push(finding(category, "low", component, `Licensed ${declared}, which the policy neither allows nor denies.`, "Decide once and record the decision in the policy."));
    }
  }

  // 7. Duplicates: the same package at two versions is how a fix reaches one
  //    copy and not the other.
  const byName = new Map();
  for (const component of components) {
    if (!byName.has(component.name)) byName.set(component.name, new Set());
    byName.get(component.name).add(component.version);
  }
  for (const [name, versions] of [...byName.entries()].sort()) {
    if (versions.size > 1) {
      findings.push(finding("duplicate-versions", "low", { name, version: [...versions].sort().join(" & "), "bom-ref": null }, `Present at ${versions.size} versions (${[...versions].sort().join(", ")}); a fix applied to one does not reach the other.`, "Deduplicate, or confirm the split is intended."));
    }
  }

  // 8. Advisories, when and only when a feed was supplied.
  let vulnerabilities = null;
  if (feed) {
    vulnerabilities = [];
    for (const component of components) {
      for (const advisory of feed.advisories ?? []) {
        if (advisory.name !== component.name) continue;
        if (!satisfiesRange(component.version, advisory.range)) continue;
        vulnerabilities.push({
          id: advisory.id,
          name: component.name,
          version: component.version,
          ref: component["bom-ref"],
          severity: FINDING_SEVERITIES.includes(advisory.severity) ? advisory.severity : "moderate",
          title: advisory.title ?? null,
          url: advisory.url ?? null,
          range: advisory.range,
          fixedIn: advisory.fixedIn ?? null,
        });
        findings.push(finding("known-vulnerability", advisory.severity, component, `${advisory.id}: ${advisory.title ?? "advisory"} affects ${advisory.range}.`, advisory.fixedIn ? `Upgrade to ${advisory.fixedIn} or later.` : "No fixed version is recorded; consider removing the dependency."));
      }
    }
    vulnerabilities.sort((left, right) => `${left.name}|${left.id}`.localeCompare(`${right.name}|${right.id}`));
  }

  const bySeverity = Object.fromEntries(FINDING_SEVERITIES.map((severity) => [severity, findings.filter((item) => item.severity === severity).length]));
  return {
    version: SUPPLY_CHAIN_VERSION,
    scope,
    components: components.length,
    findings: findings.sort((left, right) => (FINDING_SEVERITIES.indexOf(left.severity) - FINDING_SEVERITIES.indexOf(right.severity)) || `${left.id}|${left.component}`.localeCompare(`${right.id}|${right.component}`)),
    bySeverity,
    // `null`, never `[]`. An empty array from a scanner that had nothing to
    // scan with is a lie the reader has no way to detect.
    vulnerabilities,
    advisoryFeed: feed
      ? { available: true, source: feed.source ?? "unknown", advisories: (feed.advisories ?? []).length }
      : { available: false, source: null, advisories: 0, reason: "No advisory feed was supplied; the vulnerability half of this scan did not run." },
  };
}

function splitLicense(declared) {
  if (!declared) return [];
  return String(declared)
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** One paragraph a human can act on, including what was *not* checked. */
export function describeScan(report) {
  const counted = FINDING_SEVERITIES.filter((severity) => report.bySeverity[severity]).map((severity) => `${report.bySeverity[severity]} ${severity}`);
  const head = counted.length ? `${report.components} components: ${counted.join(", ")}.` : `${report.components} components, nothing flagged.`;
  if (!report.advisoryFeed.available) {
    return `${head} Known vulnerabilities were NOT checked: ${report.advisoryFeed.reason}`;
  }
  const count = report.vulnerabilities.length;
  return `${head} Checked against ${report.advisoryFeed.advisories} advisories from ${report.advisoryFeed.source}: ${count === 0 ? "no known vulnerabilities" : `${count} affected`}.`;
}

/** Does this report clear a gate? Never true when the feed was missing. */
export function scanPasses(report, { failOn = "high", requireAdvisoryFeed = true } = {}) {
  if (requireAdvisoryFeed && !report.advisoryFeed.available) {
    return { passed: false, reason: "no-advisory-feed", detail: report.advisoryFeed.reason };
  }
  const threshold = FINDING_SEVERITIES.indexOf(failOn);
  const blocking = report.findings.filter((item) => FINDING_SEVERITIES.indexOf(item.severity) <= threshold);
  if (blocking.length) {
    return { passed: false, reason: "findings", detail: `${blocking.length} finding(s) at ${failOn} or worse: ${[...new Set(blocking.map((item) => item.id))].join(", ")}` };
  }
  return { passed: true, reason: null, detail: null };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * An in-toto statement with a SLSA v1 provenance predicate.
 *
 * The subject is the set of artifact digests; the predicate says how they came
 * to exist and out of what. `resolvedDependencies` carries every component with
 * its integrity hash, so "which version of that package was in the build that
 * produced this exact file" has an answer that does not depend on anybody's
 * memory.
 *
 * There is no build timestamp, for the same reason the SBOM has none.
 */
export function buildProvenance({ artifacts = [], sbom, builderId, buildType = BUILD_TYPE, invocation = {}, sourceDigest = null } = {}) {
  if (!builderId) throw new Error("Provenance without a builder identity attests to nothing.");
  if (!artifacts.length) throw new Error("Provenance without a subject attests to nothing.");
  const materials = (sbom?.components ?? []).map((component) => ({
    uri: component.purl,
    digest: Object.fromEntries((component.hashes ?? []).map((hash) => [hash.alg.toLowerCase().replace("-", ""), hash.content])),
  })).sort((left, right) => left.uri.localeCompare(right.uri));
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [...artifacts]
      .map((artifact) => ({ name: artifact.name, digest: digestMapFor(artifact.digest) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    predicateType: SLSA_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType,
        externalParameters: {
          source: invocation.source ?? null,
          sourceDigest,
          targets: [...(invocation.targets ?? [])].sort(),
        },
        internalParameters: {
          node: invocation.node ?? null,
          platform: invocation.platform ?? null,
        },
        resolvedDependencies: materials,
      },
      runDetails: {
        builder: { id: builderId, version: { "supply-chain": String(SUPPLY_CHAIN_VERSION) } },
        metadata: {
          invocationId: invocation.invocationId ?? null,
          // Deliberately absent: startedOn / finishedOn. A wall clock in the
          // predicate makes two identical builds produce different provenance,
          // which defeats the check this document exists for.
          reproducible: true,
        },
        byproducts: sbom ? [{ name: "sbom.cdx.json", mediaType: "application/vnd.cyclonedx+json", digest: { sha256: sbomDigest(sbom).slice("sha256:".length) } }] : [],
      },
    },
  };
}

function digestMapFor(digest) {
  const [algorithm, encoded] = String(digest ?? "").split(":", 2);
  if (!encoded) return {};
  const normalized = algorithm.toLowerCase();
  // in-toto digests are hex; the update manifest carries base64, so convert
  // rather than storing two different encodings of the same bytes.
  return { [normalized]: /^[0-9a-f]+$/.test(encoded) ? encoded : Buffer.from(encoded, "base64").toString("hex") };
}

/** Sign a statement under its own subject. */
export function signProvenance(statement, keyPair) {
  return { ...statement, signature: signPayload("provenance", statement, keyPair) };
}

function refuseProvenance(reason, detail) {
  return { accepted: false, reason, detail, subject: null };
}

/**
 * Decide whether a provenance statement may be believed about these artifacts.
 *
 * Each refusal names the check that failed, for the same reason the updater
 * does: "attestation failed" is a message people learn to click through.
 */
export function verifyProvenance(statement, options = {}) {
  const { signature, ...payload } = statement ?? {};
  if (payload?._type !== IN_TOTO_STATEMENT_TYPE) return refuseProvenance("unreadable", `Not an in-toto statement (${payload?._type ?? "no type"}).`);
  if (payload?.predicateType !== SLSA_PREDICATE_TYPE) return refuseProvenance("unknown-predicate", `Predicate ${payload.predicateType} is not SLSA provenance v1.`);

  const seal = verifyPayload("provenance", payload, signature ?? null, { trustedKeyIds: options.trustedKeyIds ?? [] });
  if (!seal.verified) return { ...refuseProvenance("unsigned-or-tampered", `The attestation's signature did not verify (${seal.reason}).`), seal };
  if (seal.trust !== "trusted") return { ...refuseProvenance("untrusted-key", `Attested by ${seal.keyId}, which is not trusted here.`), seal };

  const builderId = payload.predicate?.runDetails?.builder?.id ?? null;
  if (options.expectedBuilder && builderId !== options.expectedBuilder) {
    return { ...refuseProvenance("builder-mismatch", `Built by “${builderId}”, not “${options.expectedBuilder}”.`), seal };
  }

  const artifacts = options.artifacts ?? [];
  for (const artifact of artifacts) {
    const subject = payload.subject.find((candidate) => candidate.name === artifact.name);
    if (!subject) return { ...refuseProvenance("subject-missing", `${artifact.name} is not one of the artifacts this attestation covers.`), seal };
    const expected = digestMapFor(artifact.digest);
    const [algorithm, value] = Object.entries(expected)[0] ?? [];
    if (!algorithm) return { ...refuseProvenance("bad-digest", `${artifact.name} has no readable digest to compare.`), seal };
    if (subject.digest?.[algorithm] !== value) {
      return { ...refuseProvenance("digest-mismatch", `${artifact.name} is not the file this attestation covers.`), seal };
    }
  }

  if (options.sbom) {
    const attested = new Set((payload.predicate?.buildDefinition?.resolvedDependencies ?? []).map((material) => material.uri));
    const missing = (options.sbom.components ?? []).map((component) => component.purl).filter((purl) => !attested.has(purl));
    if (missing.length) {
      return { ...refuseProvenance("material-missing", `${missing.length} component(s) in the bill of materials are absent from the attestation, starting with ${missing[0]}.`), seal };
    }
  }

  return {
    accepted: true,
    reason: null,
    detail: null,
    seal,
    subject: payload.subject,
    builder: builderId,
    materials: (payload.predicate?.buildDefinition?.resolvedDependencies ?? []).length,
  };
}

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

/**
 * Compare two builds of the same source.
 *
 * "Reproducible: false" is useless on its own — the whole difficulty of making
 * a build reproducible is finding *which* file moved and why — so the result
 * names every artifact that differs and how.
 */
export function compareBuilds(first, second) {
  const differences = [];
  const firstByName = new Map((first ?? []).map((artifact) => [artifact.name, artifact]));
  const secondByName = new Map((second ?? []).map((artifact) => [artifact.name, artifact]));
  for (const [name, artifact] of firstByName) {
    const twin = secondByName.get(name);
    if (!twin) {
      differences.push({ name, reason: "missing-in-second", first: artifact.digest, second: null });
      continue;
    }
    if (twin.digest !== artifact.digest) {
      differences.push({
        name,
        reason: twin.size !== artifact.size ? "size-and-digest" : "digest-only",
        first: artifact.digest,
        second: twin.digest,
        firstSize: artifact.size ?? null,
        secondSize: twin.size ?? null,
      });
    }
  }
  for (const [name, artifact] of secondByName) {
    if (!firstByName.has(name)) differences.push({ name, reason: "missing-in-first", first: null, second: artifact.digest });
  }
  differences.sort((left, right) => left.name.localeCompare(right.name));
  return { reproducible: differences.length === 0, compared: firstByName.size, differences };
}

/**
 * Where two byte streams first differ, with a little context.
 *
 * When a build stops being reproducible the answer is almost always an
 * embedded timestamp or an absolute path, and both are legible at the offset.
 */
export function firstByteDifference(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  const limit = Math.min(a.length, b.length);
  for (let offset = 0; offset < limit; offset += 1) {
    if (a[offset] !== b[offset]) {
      return {
        identical: false,
        offset,
        first: a.subarray(Math.max(0, offset - 16), offset + 16).toString("latin1"),
        second: b.subarray(Math.max(0, offset - 16), offset + 16).toString("latin1"),
      };
    }
  }
  if (a.length !== b.length) return { identical: false, offset: limit, first: `length ${a.length}`, second: `length ${b.length}` };
  return { identical: true, offset: null, first: null, second: null };
}

/**
 * The summary a renderer may see.
 *
 * Component names and versions are public facts about a published package, so
 * there is nothing sensitive here — but paths on the build machine are, and
 * `npm:path` is dropped rather than passed on.
 */
export function publicSupplyChainReport(bom, scan) {
  return {
    version: SUPPLY_CHAIN_VERSION,
    format: `${bom.bomFormat} ${bom.specVersion}`,
    serialNumber: bom.serialNumber,
    digest: sbomDigest(bom),
    application: { name: bom.metadata.component.name, version: bom.metadata.component.version },
    counts: {
      total: bom.components.length,
      runtime: runtimeComponents(bom).length,
      development: bom.components.length - runtimeComponents(bom).length,
    },
    licenses: licenseBreakdown(bom),
    scan: {
      scope: scan.scope,
      bySeverity: scan.bySeverity,
      advisoryFeed: scan.advisoryFeed,
      vulnerabilities: scan.vulnerabilities,
      findings: scan.findings.map((item) => ({ id: item.id, severity: item.severity, component: item.component, detail: item.detail, remediation: item.remediation })),
      summary: describeScan(scan),
    },
  };
}

export function licenseBreakdown(bom) {
  const counts = new Map();
  for (const component of bom.components ?? []) {
    const declared = component.licenses?.[0]?.license?.id ?? "UNKNOWN";
    counts.set(declared, (counts.get(declared) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([license, count]) => ({ license, count }));
}
