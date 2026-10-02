import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_API_VERSION, PLUGIN_CAPABILITIES, PLUGIN_KINDS, entryDigest, inspectPlugin, signPluginManifest } from "../electron/plugins.mjs";
import { loadOrCreateKeyPair, publicIdentity } from "../electron/signing.mjs";

/**
 * Sign and check a plugin directory (item 58).
 *
 * `sign` computes the entry file's digest, writes it into the manifest, and
 * signs the result — in that order, because signing a manifest that did not
 * pin the code would certify a filename. `check` runs the exact code the
 * application runs at load time, so "it works in the tool" and "it loads in the
 * app" cannot diverge.
 */

function argumentValue(name, fallback = null) {
  const prefixed = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : fallback;
}

export async function signPluginDirectory(directory, keyDirectory) {
  const manifestPath = path.join(directory, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const source = await readFile(path.resolve(directory, manifest.entry), "utf8");
  const { signature: _previous, ...unsigned } = manifest;
  const pinned = { ...unsigned, entryDigest: entryDigest(source) };
  const keyPair = await loadOrCreateKeyPair(keyDirectory);
  const signed = signPluginManifest(pinned, keyPair);
  await writeFile(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
  return { manifestPath, keyId: keyPair.keyId, identity: publicIdentity(keyPair), entryDigest: pinned.entryDigest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const directory = path.resolve(argumentValue("dir", process.argv[3] ?? "."));
  if (command === "sign") {
    const result = await signPluginDirectory(directory, argumentValue("keys", path.join(directory, "..", ".keys")));
    console.log(JSON.stringify({ signed: result.manifestPath, keyId: result.keyId, entryDigest: result.entryDigest }, null, 2));
  } else if (command === "check") {
    const trusted = argumentValue("trust", "").split(",").filter(Boolean);
    const inspected = await inspectPlugin(directory, { trustedKeyIds: trusted });
    console.log(JSON.stringify({
      id: inspected.id,
      loaded: inspected.loaded,
      reason: inspected.reason,
      detail: inspected.detail,
      granted: inspected.granted ?? [],
      withheld: inspected.withheld ?? [],
    }, null, 2));
    if (!inspected.loaded) process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      usage: "node scripts/plugin-tool.mjs <sign|check> --dir=<plugin directory> [--keys=<key directory>] [--trust=<keyId,...>]",
      apiVersion: PLUGIN_API_VERSION,
      kinds: PLUGIN_KINDS,
      capabilities: PLUGIN_CAPABILITIES,
    }, null, 2));
    process.exitCode = 1;
  }
}
