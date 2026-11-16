---
name: preset-sync
description: Synchronize BB settings and local plugin sources through the user's configured preset Git repository.
---

Use `bb preset status` for directional changes and `bb preset diff` for a pull preview.
`bb preset capture` stages the current selection. `bb preset push` publishes the
stage; `bb preset push --fresh` captures and publishes current files. Push and
confirmed pull change external or local configuration, so use them when requested.
`bb preset pull --yes` applies the current remote preset, including full-trust plugin code.

Settings under Settings → Plugins → Preset Sync select general preferences,
appearance, shortcuts, experiments, non-secret plugin settings, and local plugin
source code. Disabled categories preserve local values during pull and existing
repository values during push. Capture again after enabling an unstaged category.

Local source files live in Git under `preset/local-plugins/<id>`. Pull requires
npm on the receiving machine, disables dependency lifecycle scripts, and installs
into a new version directory while preserving old sources and settings. Non-path
installations with the same id are not removed. CloudPub's clo and Git Kanban's gh
must be installed and authenticated separately. Credentials and runtime data are
not transferred. Preset Sync's own source is a bootstrap artifact, not an automatic
self-update during pull.

When changing this plugin, run `npm run typecheck`,
`npm test -- --fileParallelism=false`, `bb plugin build .`, and
`bb plugin reload preset-sync`. Inspect source capture before publishing.
