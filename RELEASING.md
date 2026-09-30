# Releasing

Releases go to npm as `@repotify/repotify`, with provenance, from GitHub Actions only.

1. **Check.** `npm test`, `npm run eval`, `node pipeline/verify.mjs catalog` and `npm pack --dry-run` all pass on `main`.
2. **Version.** Bump `version` in `package.json` (semver; while in 0.x, a minor bump may break) and move the
   `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) under the new version with today's date.
3. **Commit and push** to `main`, and wait for `ci` to go green on every Node version.
4. **Release.** On GitHub: Releases → Draft a new release → tag `v<version>` (create it on publish, target `main`),
   title `Repotify <version>`, notes from the changelog → Publish. The tag starts `release.yml`, which runs the tests,
   the eval and the catalog check again, verifies that the tag matches `package.json`, and runs
   `npm publish --provenance --access public`.
5. **Verify** from a clean folder: `npx -y @repotify/repotify@latest --version` prints the new version, and the npm
   page shows the provenance badge.

The `npm` environment needs `NPM_TOKEN` (write access to the `@repotify` scope) unless npm trusted publishing is set up
for this repository. If a release is bad, deprecate it (`npm deprecate @repotify/repotify@<version> "<why>"`) and
release a fix; npm allows unpublishing only within 72 hours.
