import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactDigest, buildUpdateManifest, signUpdateManifest } from "../electron/updates.mjs";
import { loadOrCreateKeyPair, publicIdentity } from "../electron/signing.mjs";
import { BUILD_TYPE, buildProvenance, buildSbom, describeScan, sbomDigest, scanDependencies, signProvenance } from "../electron/supply-chain.mjs";

/**
 * Build the release payload and its signed update manifest (item 55).
 *
 * What this does and does not do is worth being exact about, because "signed
 * releases" is the kind of phrase that hides a gap.
 *
 * **It does**: assemble the exact set of files that go inside any installer,
 * per platform and architecture, reproducibly; compute the digest of the bytes
 * that will be executed; and produce an update manifest signed with the same
 * Ed25519 machinery item 45 uses for course packages, under its own subject.
 * That is the security-critical half of an auto-updater, and it is testable
 * without a certificate, a notary, or a network.
 *
 * **It does not**: produce a `.dmg`, an `.msi`, or an `.AppImage`, or sign the
 * application binary itself. Those need a paid Apple Developer ID, an
 * Authenticode certificate, Apple's notary service, and — for cross-building —
 * the other platforms' toolchains. Those are credentials and external services
 * this build does not have, and inventing a placeholder signature would be
 * worse than not having one: it would make an unsigned build look signed.
 * `electron-builder.yml` declares exactly what those steps must do, and
 * `npm run release` refuses to claim they happened.
 */

const PAYLOAD = ["dist", "electron", "package.json", "README.md"];

const TARGETS = [
  { platform: "darwin", arch: "arm64", target: "dmg" },
  { platform: "darwin", arch: "x64", target: "dmg" },
  { platform: "win32", arch: "x64", target: "nsis" },
  { platform: "linux", arch: "x64", target: "AppImage" },
];

async function fileList(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await fileList(root, next));
    else files.push(next);
  }
  return files;
}

/**
 * A deterministic ustar archive, written here rather than shelled out to `tar`.
 *
 * The first attempt called `tar --sort=name --mtime=...`, which BSD tar — the
 * one macOS ships — does not support, so the release script worked on Linux
 * only. That is precisely the class of defect item 54 spent its time removing,
 * and a release script that runs on one platform is not a release script.
 *
 * Fixed mode, owner, and timestamp, with entries in sorted order, so two builds
 * of the same source produce byte-identical archives. Reproducibility is not a
 * nicety: it is what lets somebody else check that the artifact a manifest
 * describes is the one this source builds.
 */
function ustarHeader({ name, size, mode = 0o644, type = "0", mtime = 0 }) {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => header.write(String(value).slice(0, length - 1), offset, length - 1, "utf8");
  const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "utf8");
  // Long paths split across `prefix` and `name`, which is what ustar is for.
  const split = name.length <= 100 ? { prefix: "", short: name } : (() => {
    const cut = name.lastIndexOf("/", name.length - 100);
    return cut > 0 ? { prefix: name.slice(0, cut), short: name.slice(cut + 1) } : { prefix: "", short: name.slice(-100) };
  })();
  write(split.short, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  header.write("        ", 148, 8, "utf8");
  write(type, 156, 2);
  header.write("ustar\0", 257, 6, "binary");
  header.write("00", 263, 2, "binary");
  write("", 265, 32);
  write("", 297, 32);
  octal(0, 329, 8);
  octal(0, 337, 8);
  write(split.prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  return header;
}

function tarball(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = entry.type === "5" ? Buffer.alloc(0) : entry.body;
    blocks.push(ustarHeader({ name: entry.name, size: body.length, mode: entry.mode, type: entry.type ?? "0" }));
    if (body.length) {
      blocks.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  // Two empty blocks end the archive, then the standard 10 KiB minimum.
  blocks.push(Buffer.alloc(1_024));
  return Buffer.concat(blocks);
}

async function collect(projectRoot) {
  const entries = [];
  for (const top of PAYLOAD) {
    const absolute = path.join(projectRoot, top);
    const details = await stat(absolute);
    if (details.isDirectory()) {
      for (const relative of await fileList(absolute)) {
        entries.push({ name: `${top}/${relative}`, body: await readFile(path.join(absolute, relative)) });
      }
    } else {
      entries.push({ name: top, body: await readFile(absolute) });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function packageTarget(projectRoot, outputDirectory, version, target, sbom) {
  const name = `trace-${version}-${target.platform}-${target.arch}.tar.gz`;
  const destination = path.join(outputDirectory, name);
  const entries = await collect(projectRoot);
  // The bill of materials travels *inside* the artifact (item 56). An SBOM kept
  // only on the build server describes something the person holding the file
  // cannot check; one shipped alongside the bytes it describes can be compared
  // with what is actually there.
  entries.push({ name: "sbom.cdx.json", body: Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`) });
  entries.push({
    name: "BUILD_INFO.json",
    // Deliberately no timestamp: a build stamp makes every artifact unique and
    // destroys the only property that makes a digest worth comparing.
    body: Buffer.from(`${JSON.stringify({ version, platform: target.platform, arch: target.arch, target: target.target, files: entries.length, sbomDigest: sbomDigest(sbom) }, null, 2)}\n`),
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const archive = gzipSync(tarball(entries), { level: 9 });
  await writeFile(destination, archive);
  return {
    ...target,
    name,
    size: (await stat(destination)).size,
    digest: artifactDigest(archive),
    url: null,
  };
}

export async function buildRelease({ projectRoot = path.resolve("."), outputDirectory, channel = "stable", notes = "", minimumFrom = null, keyDirectory, advisories = null } = {}) {
  const manifestPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const version = manifestPackage.version;
  const output = outputDirectory ?? path.join(projectRoot, "release");
  await mkdir(output, { recursive: true });

  // Built once and shared by every target, so all four artifacts attest to the
  // same materials rather than to four separate readings of the tree.
  const sbom = await buildSbom({ projectRoot });
  const scan = scanDependencies(sbom, { advisories });

  const artifacts = [];
  for (const target of TARGETS) artifacts.push(await packageTarget(projectRoot, output, version, target, sbom));

  const manifest = buildUpdateManifest({ product: "trace", releaseVersion: version, channel, notes, minimumFrom, artifacts, releasedAt: "2020-01-01T00:00:00.000Z" });
  const keyPair = await loadOrCreateKeyPair(keyDirectory ?? path.join(output, "keys"));
  const signed = signUpdateManifest(manifest, keyPair);

  // The attestation cannot live inside the artifacts it is about — it names
  // their digests — so it goes beside them, signed under its own subject.
  const provenance = signProvenance(buildProvenance({
    artifacts,
    sbom,
    builderId: `local-npm-release/${manifestPackage.name}`,
    buildType: BUILD_TYPE,
    invocation: {
      source: manifestPackage.name,
      targets: TARGETS.map((target) => `${target.platform}/${target.arch}`),
      node: process.version,
      // The platform is recorded because a cross-platform difference is the
      // first thing to look at when a rebuild does not match; it is not part of
      // the subject, so it cannot make the artifacts differ.
      platform: `${process.platform}-${process.arch}`,
      invocationId: null,
    },
    sourceDigest: sbomDigest(sbom),
  }), keyPair);

  await writeFile(path.join(output, "latest.json"), JSON.stringify(signed, null, 2));
  await writeFile(path.join(output, "public-key.json"), JSON.stringify(publicIdentity(keyPair), null, 2));
  await writeFile(path.join(output, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(path.join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(path.join(output, "dependency-scan.json"), `${JSON.stringify(scan, null, 2)}\n`);

  return {
    version,
    output,
    manifest: signed,
    identity: publicIdentity(keyPair),
    sbom,
    provenance,
    scan,
    scanSummary: describeScan(scan),
    // Stated on every build so a consumer cannot mistake this for a signed,
    // notarized installer.
    signedApplication: false,
    notarized: false,
    installers: [],
    limitation: "The payload and its manifest are signed; the application binaries and installers are not. That needs an Apple Developer ID, an Authenticode certificate, and Apple's notary service.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await buildRelease({ outputDirectory: process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined });
  console.log(JSON.stringify({
    version: result.version,
    output: result.output,
    artifacts: result.manifest.artifacts.map((artifact) => ({ name: artifact.name, size: artifact.size, digest: `${artifact.digest.slice(0, 24)}…` })),
    keyId: result.identity.keyId,
    sbom: { serialNumber: result.sbom.serialNumber, digest: sbomDigest(result.sbom), components: result.sbom.components.length },
    provenance: { subjects: result.provenance.subject.length, materials: result.provenance.predicate.buildDefinition.resolvedDependencies.length, builder: result.provenance.predicate.runDetails.builder.id },
    scan: result.scanSummary,
    signedApplication: result.signedApplication,
    notarized: result.notarized,
    limitation: result.limitation,
  }, null, 2));
}
