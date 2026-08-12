# Public Release Sanitization Report

**Prepared:** 2026-08-11
**Scope:** Trace source, tests, documentation, configuration, and tutorial media

## Removed or neutralized categories

- Machine-specific absolute paths and local repository locations.
- Personal identity and employer-association terms supplied by the owner.
- Legacy profile initials that could connect the project to a private development identity.
- Private repository commit identifiers, dirty-worktree state, and local author context in public screenshots.
- Archive metadata, AppleDouble artifacts, macOS extended attributes, and nonessential image metadata.
- Credential-shaped files and common token, key, JWT, and secret-assignment patterns.

No removed value is reproduced in this report. The automated scanner reports only a relative path, rule name, and line number.

## Data-boundary correction

Trace now distinguishes local repository indexing and storage from optional agent use. Agent calls are explicit and read-only, but the selected context pack is sent through the user's configured provider.

## Verification commands

```bash
npm ci
npm run build
npm test
npm run test:ui
npm run test:electron
npm run scan:public
npm audit
```

Before any public commit, run the staged gate as well:

```bash
node scripts/public-safety.mjs --staged
git diff --cached --check
git diff --cached --name-only
```

## Media verification

The six tutorial PNGs must be regenerated from sanitized source when the UI changes, re-encoded, stripped of extended attributes, scanned for printable identity data, and reviewed visually at original resolution.
