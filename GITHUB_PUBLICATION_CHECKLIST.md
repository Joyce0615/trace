# GitHub Publication Checklist

Do not create or push a public repository until every item is checked.

## Ownership and licensing

- [x] The owner selected the MIT License and the root `LICENSE` matches `package.json`.
- [x] Third-party educational excerpts have a pinned upstream revision and license attribution.

## Safety

- [x] Full-tree identity and credential scan passes.
- [x] Scanner covers file contents, filenames, path components, and staged files.
- [x] Sensitive test values are assembled from split literals rather than stored verbatim.
- [x] Tutorial images were regenerated, metadata-cleaned, string-scanned, and visually reviewed.
- [x] The final staged set passes `node scripts/public-safety.mjs --staged`.
- [x] All files reachable from the release branch were checked after the first commit.

## Runtime and quality

- [x] Node.js requirement is declared as `>=22.12.0` with a matching `.nvmrc`.
- [x] `npm ci` completes under Node 22.12 or newer without engine warnings.
- [x] Build, core tests, UI smoke test, Electron smoke test, and dependency audit pass on the sanitized pre-Git tree.
- [x] The same complete gate passes on the final staged tree.

## Repository creation

- [x] Local branch is named `main`.
- [x] `git remote` is empty before repository creation.
- [x] The owner explicitly authorized creation of the public GitHub repository.
- [x] The owner explicitly authorized the final push.
- [x] Repository description and topics do not expose private affiliations.
