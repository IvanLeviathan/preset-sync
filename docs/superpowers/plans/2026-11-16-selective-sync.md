# Selective settings sync

Implement category selection using the existing plugin settings UI. All categories remain enabled by default. Disabled categories are omitted from captures and pull plans, and retained from the current remote preset during push. Plugin installation remains additive during pull. Never export unknown general settings.

1. Reproduce the general-settings capture failure in the server harness, then explicitly capture the six supported portable fields.
2. Add boolean settings for general settings, experiments, keyboard shortcuts, and appearance; apply the existing plugin-settings switch to both directions.
3. Permit omitted settings categories in preset files. Test partial file round-trips, directional plans, remote preservation, and selective capture/apply. Retain strict validation for categories that are present.
4. Merge omitted categories from the remote clone immediately before writing, so disabled settings survive push. Apply current selection even to an older staged capture.
5. Run targeted tests, full tests, type checking, and build. Back up the current plugin configuration, replace its Git registration with the local path, restore settings, and verify capture/status without pushing or applying a remote preset.

Compatibility: full version-1 presets remain supported. A partial preset requires this local version on every participating machine; the upstream version expects every category.
