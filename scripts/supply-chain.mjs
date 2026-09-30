import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildSbom, describeScan, importNpmAudit, licenseBreakdown, runtimeComponents, sbomDigest, scanDependencies, scanPasses } from "../electron/supply-chain.mjs";

const run = promisify(execFile);

/**
 * Produce the bill of materials and scan it (item 56).
 *
 * `npm audit` is the advisory feed, and it needs the network. That is stated
 * rather than hidden: with `--audit` the report says which feed it used and how
 * many advisories it held; without it — or when the registry cannot be reached
 * — the report says the vulnerability half did not run and `--fail-on` refuses
 * to pass. A supply-chain gate that goes green because it could not reach its
 * database is worse than one that fails.
 */

function argumentValue(name, fallback = null) {
  const prefixed = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
}

/** Ask npm for advisories. Returns `null` — never an empty feed — on failure. */
export async function collectAdvisories(projectRoot, { omitDev = false } = {}) {
  const args = ["audit", "--json"];
  if (omitDev) args.push("--omit=dev");
  try {
    // `npm audit` exits non-zero when it finds something, so the payload is
    // read from the error as well as from a clean run.
    const { stdout } = await run("npm", args, { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 });
    return importNpmAudit(JSON.parse(stdout));
  } catch (cause) {
    const stdout = cause?.stdout ?? "";
    if (stdout.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(stdout);
        // An audit that failed to reach the registry reports an error object
        // rather than a vulnerability map; that is not a clean feed.
        if (parsed.error) return null;
        return importNpmAudit(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function supplyChainReport({ projectRoot = path.resolve("."), advisories = null, scope = "all" } = {}) {
  const sbom = await buildSbom({ projectRoot });
  const scan = scanDependencies(sbom, { advisories, scope });
  return { sbom, scan };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const projectRoot = path.resolve(argumentValue("root", "."));
  const outputDirectory = path.resolve(argumentValue("out", "artifacts"));
  const scope = argumentValue("scope", "all");
  const advisories = process.argv.includes("--audit") ? await collectAdvisories(projectRoot, { omitDev: scope === "runtime" }) : null;
  const { sbom, scan } = await supplyChainReport({ projectRoot, advisories, scope });

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(path.join(outputDirectory, "dependency-scan.json"), `${JSON.stringify(scan, null, 2)}\n`);

  const gate = scanPasses(scan, {
    failOn: argumentValue("fail-on", "high"),
    requireAdvisoryFeed: process.argv.includes("--require-advisories"),
  });
  console.log(JSON.stringify({
    sbom: {
      format: `${sbom.bomFormat} ${sbom.specVersion}`,
      serialNumber: sbom.serialNumber,
      digest: sbomDigest(sbom),
      components: sbom.components.length,
      runtime: runtimeComponents(sbom).length,
      licenses: licenseBreakdown(sbom).slice(0, 8),
    },
    scan: { bySeverity: scan.bySeverity, advisoryFeed: scan.advisoryFeed, vulnerabilities: scan.vulnerabilities },
    summary: describeScan(scan),
    gate,
    wrote: [path.join(outputDirectory, "sbom.cdx.json"), path.join(outputDirectory, "dependency-scan.json")],
  }, null, 2));
  if (!gate.passed) {
    console.error(`Supply-chain gate failed: ${gate.detail}`);
    process.exitCode = 1;
  }
}
