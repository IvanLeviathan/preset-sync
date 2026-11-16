# Changelog

## 0.3.1-local.1

- Resolve Windows npm shims to Node and npm-cli.js directly, including NVM and
  per-user installations, while keeping arguments separate and shell disabled.
- Explain stale BB process environments when npm is available only in a terminal.
- Omit third-party source confirmation for official catalog installations, fixing
  machine-load, machine-monitor, and mcp-hub restoration.

## 0.3.0-local.1

- Synchronize local path plugin sources through readable Git source trees.
- Cache immutable staged bundles outside KV and verify SHA-256 on import.
- Install source updates into new directories while preserving prior sources
  and plugin settings through BB's path-to-path move.
- Prepare dependencies without lifecycle scripts or unrequested lockfile edits.
- Include a bootstrap source copy for installing this version on another machine.
- Preserve remote source bundles when local-source synchronization is disabled.

## 0.2.2-local.1

- Capture only the six supported portable general settings, so newer BB fields
  no longer prevent export.
- Choose which settings categories participate in capture, push, and pull.
- Preserve excluded remote categories and plugin settings during push.
- Respect current selection when pushing an older staged capture.
- Preserve current machine fields when applying portable general settings.
- Preview and initialize an empty remote repository on the configured branch.

## 0.2.2

- Restore `plugin@marketplace` entries through BB's catalog API instead of
  treating them as machine-local package paths.
- Confirm the resolved source from the catalog install plan before installing
  third-party marketplace plugins.

## 0.2.1

- Show directional `↓ remote` and `↑ local` change counts in the BB sidebar.
- List the exact pull and push changes with explicit actions on the Preset Sync page.
- Add a configurable background comparison interval from one to sixty minutes,
  including an Off option.
- Keep the background indicator silent while the preset is fully synchronized.

## 0.2.0

- Publish a generic configuration with no user-specific repository default.
- Add a dedicated Preset Sync page to the BB sidebar.
- Explain first-time setup in the UI and CLI.
- Allow `push --fresh` to initialize an existing Git repository that has no
  preset files yet.
- Add frontend registration coverage and public-release documentation.

## 0.1.3

- Harden Git input validation, secret filtering, path filtering, and preset
  filesystem handling.
