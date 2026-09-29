/*
 * Notarization, as a step that refuses to pretend (item 55).
 *
 * Called by electron-builder after signing. It fails loudly when the
 * credentials are absent rather than skipping quietly, because a release that
 * silently shipped un-notarized is one that Gatekeeper will refuse on the
 * learner's machine, days later, with no explanation anybody can act on.
 *
 * `TRACE_ALLOW_UNNOTARIZED=1` makes a local, clearly-labelled unsigned build
 * possible without making an unnotarized *release* possible by accident.
 */
exports.default = async function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    if (process.env.TRACE_ALLOW_UNNOTARIZED === "1") {
      console.warn(`Skipping notarization: ${missing.join(", ")} not set. This build must not be published.`);
      return;
    }
    throw new Error(`Cannot notarize: ${missing.join(", ")} are not set. Set TRACE_ALLOW_UNNOTARIZED=1 for a local build that will not be published.`);
  }
  const { notarize: run } = require("@electron/notarize");
  await run({
    appBundleId: "dev.trace.studio",
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
