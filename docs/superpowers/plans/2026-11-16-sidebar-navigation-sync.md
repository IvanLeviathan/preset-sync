# Sidebar Navigation Sync Implementation Plan

> **For agentic workers:** Use the native execution method in this session. The user requested implementation and then instructed the agent to continue.

**Goal:** Synchronize the sidebar navigation order and shown/hidden destinations across machines.

**Architecture:** Add an optional `settings.sidebarNavigation` category containing `order: string[]` and `visible: string[] | null`. Read and write the two corresponding server UI preferences through the public SDK; keep revisions local. Add an enabled-by-default selection setting and directional previews.

**Tech Stack:** TypeScript, Zod, BB Plugin SDK, Vitest.

**Spec:** User request in thread `thr_2hn42vb4yv`: synchronize sidebar plugin sorting and visibility.

## Global Constraints

- Preserve existing settings when an old preset omits this category.
- Disabled categories preserve local pull values and existing remote push values.
- Export only the two navigation preferences, without revisions or unrelated UI preferences.

## Review Focus

- Empty order and null visibility must round-trip as explicit defaults.
- Empty visibility means hide every destination, not the default null value.
- Concurrent preference edits must produce a revision conflict without blind overwrites.
- Missing categories in old captures must not reset local navigation.
- Disabled synchronization must apply to staged pushes as well as new captures.

### Task 1: Implement the category

**Files:** `lib/preset.ts`, `lib/service.ts`, `server.ts`, `tests/sidebar-navigation.test.ts`, existing selective-sync fixtures, `package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md`, `skills/preset-sync/SKILL.md`.

**Interfaces:** Public SDK `system.uiPreferences.list()` and `.set({ key, expectedRevision, value })`. Category selection `includeSidebarNavigation` defaults to true.

- [x] Add failing tests for category file round-trips, both plan directions, capture filtering, pull state, old presets, and write conflicts.
- [x] Run `npm test -- tests/sidebar-navigation.test.ts --fileParallelism=false`; confirm missing-feature failures.
- [x] Add schema, read/write, directional plans, selection, and revision-checked application. Update documentation.
- [x] Run focused tests, then `npm run typecheck`, `npm test -- --fileParallelism=false`, `bb plugin build .`, and `bb plugin reload preset-sync`.
- [x] Inspect the live preview and source capture. Publish only through the user's authorized preset operation.
