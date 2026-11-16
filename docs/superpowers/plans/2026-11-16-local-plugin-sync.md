# Local Plugin Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize local BB plugin source code through the configured preset Git repository, including git-kanban and cloudpub.

**Architecture:** Store portable source bundles by SHA-256 in the plugin-owned SQLite database, keeping large source contents out of the 256KB KV store. Commit readable source files under preset/local-plugins/<id>. Pull materializes an immutable local version, installs dependencies without lifecycle scripts, and uses BB's supported path-to-path move to preserve plugin configuration and previous source directories. Existing non-path installations are never removed automatically.

**Tech Stack:** TypeScript, Node filesystem/crypto/child_process, public BB Plugin SDK, SQLite, Git, npm, Vitest.

**Spec:** User request in this thread: transfer local git-kanban/cloudpub plugins through the same preset repository for use across machines.

## Global Constraints

- Never copy node_modules, dist, Git history, databases, logs, environment files, saved credentials, or private keys.
- Reject symlinks, unsafe paths, manifest/id mismatches, credential-bearing manifests, and excessive source sizes. Hash paths, executable bits, and file bytes deterministically.
- Pull requires the existing full-trust preview confirmation; install into a new version directory before switching BB's path registration.
- Keep source data out of KV and status/RPC payloads. Bound every bundle to 2,000 files and 20 MiB, and every file to 5 MiB.
- npm installation uses --ignore-scripts and is the only dependency preparation; CLI credentials and platform tools remain local.
- Preserve complete and partial settings presets, selective-sync semantics, and non-force Git pushes.

## Review Focus

- A malicious bundle path or symlink must never read/write outside the chosen tree.
- A failed dependency install or BB build must keep the existing plugin registered and its source folder intact.
- A source-only change with unchanged package version must appear in preview and update on pull.
- Disabling local-plugin sync must preserve existing remote bundles; staged sources must remain available after reload.
- The receiver needs a bootstrap copy of this customized preset-sync, since the upstream plugin cannot read bundled sources.

### Task 1: Portable source bundles

Files: lib/local-plugins.ts, tests/local-plugins.test.ts.
- [ ] Add failing tests for deterministic capture, exclusions, symlink/path/id/hash rejection, and SQLite persistence across store instances.
- [ ] Implement bounded capture, validation, repository read/write, and persistent source cache.

### Task 2: Preset and synchronization integration

Files: lib/preset.ts, lib/service.ts, lib/git.ts, server.ts, tests/preset.test.ts, tests/selection.test.ts, tests/git.test.ts.
- [ ] Test bundle references, source-only plan changes, Git round-trip, disabled-category preservation, and staged cache use.
- [ ] Add includeLocalPlugins setting, bundle capture, Git export/import, and safe versioned path installation/update.
- [ ] Include a non-auto-applied bootstrap source for preset-sync in the repository.

### Task 3: Verification and delivery

Files: README.md, CHANGELOG.md, package.json, package-lock.json.
- [ ] Document npm/CLI prerequisites, source exclusions, update behavior, and bootstrap installation.
- [ ] Run focused tests, all tests serially, type checking, build, independent review, and live capture.
- [ ] Reload and publish the requested preset with local plugin sources; verify the committed source trees and hashes without applying remote plugins to the development machine.
