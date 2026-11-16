# BB Preset Sync

Preset Sync keeps portable BB plugins and settings aligned across computers
through a Git repository. It adds a **Preset Sync** page to the BB sidebar, a
section under **Settings → Plugins → Preset Sync**, and the `bb preset` command.

## Install

From the y5k marketplace:

```bash
bb marketplace add git:https://github.com/imyeskela/y5k-bb-marketplace.git@main
bb plugin install preset-sync@y5k --yes
```

Or install the tagged release directly:

```bash
bb plugin install git:https://github.com/imyeskela/bb-plugin-preset-sync.git@v0.2.2 --yes
```

## First setup

1. Create a Git repository for the preset. For a private GitHub repository,
   initialize it with a README so that the `main` branch exists.
2. Set **Preset repository** under **Settings → Plugins → Preset Sync**, or run:

   ```bash
   bb plugin config preset-sync set repositoryUrl https://github.com/OWNER/bb-preset.git
   ```

3. Make sure Git can authenticate. For GitHub, the usual setup is:

   ```bash
   gh auth login
   gh auth setup-git
   ```

   Alternatively, store a PAT in the secret **GitHub token** plugin setting.
   Secret settings are kept out of the frontend and are never captured.

4. Capture this computer and initialize or update the preset:

   ```bash
   bb preset push --fresh
   ```

On another computer, install the plugin, configure the same repository, preview
the changes, and apply them:

```bash
bb preset diff
bb preset pull --yes
```

`pull` without `--yes` only prints a preview and changes nothing. Pull is
additive: locally installed plugins that are absent from the preset are kept.

The sidebar indicator stays hidden while the local and remote presets match.
When they differ, Top list navigation shows `↓` for changes available from the
remote preset and `↑` for local changes available to push. Rail navigation shows
a dot; its tooltip contains the counts and changes. Open Preset Sync to review
every change and choose a direction.

Background comparisons run every five minutes by default. Change
**Background check interval** under **Settings → Plugins → Preset Sync** to
`Off`, 1, 5, 10, 15, 30, or 60 minutes. A background check never pulls or
pushes automatically.

## Choose settings to synchronize

Under **Settings → Plugins → Preset Sync**, enable or disable **Sync general
settings**, **Sync appearance**, **Sync sidebar navigation**, **Sync sidebar footer**, **Sync keyboard shortcuts**, **Sync experiments**,
and **Sync non-secret plugin settings**. All categories are enabled by default.

Disabled categories are omitted from new captures and pull previews. Pull keeps
their local values; push preserves their existing values in the repository. A
new repository contains only the selected settings categories. Plugin lists and
marketplaces still synchronize as before.

The current selection also filters previously staged captures before push. Run
**Stage current** again after enabling a category that was absent from the stage.
Unknown BB general settings, including machine access and server configuration,
are never captured.

**Sync sidebar navigation** transfers the order and shown/hidden destinations
in the sidebar, including built-in destinations. It applies to both Rail and
Top list navigation. A preset without this category leaves the sidebar unchanged.
The `null` visibility value means show all destinations; an empty list means
move all destinations into More. UI preference revisions stay on each machine;
concurrent edits are reported as pull errors. Both machines need this version
of Preset Sync and a BB host with Plugin SDK 0.6.132 or newer.

**Sync sidebar footer** separately transfers the order and hidden footer actions
(`sidebar.footerOrder` and `sidebar.hiddenFooterItems`). Empty order uses the host
default order; an empty hidden list shows every available footer action. Old
presets without this category keep the local footer. Pull checks capture-time
revisions and reports each successful write separately if another write fails.

An empty Git repository is supported: preview shows the initial local changes,
and **Capture & push** creates the configured branch and preset files. A missing
branch in a repository that already has refs remains an error.

Complete upstream version-1 presets remain supported. To read a preset with
omitted categories, every participating machine needs this local version;
upstream 0.2.2 requires all categories to be present.

This installation uses the local source at
`~/.bb/plugins/preset-sync/preserved-source`. Run `bb plugin build .` and
`bb plugin reload preset-sync` after editing it.

## Commands

```text
bb preset status
bb preset diff
bb preset capture
bb preset push
bb preset push --fresh
bb preset pull --yes
```

## Local plugins across machines

**Sync local plugin sources** is enabled by default. Capture includes portable
source files for local `path:` plugins, such as Git Kanban and CloudPub. Git
stores readable trees under `preset/local-plugins/<id>/`. SHA-256 hashes detect
code changes even when a package version is unchanged. Staged code is cached in
Preset Sync's own SQLite database, so later edits do not change an existing stage.

Pull installs a new plugin or updates an existing path plugin in a new local
version directory. BB moves the registration while preserving plugin settings;
the previous source directory stays on disk. Failed dependency preparation or
an unsuccessful path-to-path build keeps the previous installation. Plugins
already installed from Git, npm, or the catalog are kept rather than removed.

Receiving local sources requires Node.js and `npm` on PATH. Dependencies are
prepared with `npm ci` when a lockfile exists, or `npm install` without creating
a lockfile otherwise. Both commands disable lifecycle scripts. Native or
platform-specific dependencies that need install scripts require separate local
setup. Git Kanban also needs an authenticated `gh`; CloudPub needs an installed,
authenticated `clo`. Those programs and their saved credentials are not copied.

On Windows, Preset Sync resolves `node.exe` and `npm-cli.js` from BB's environment,
including NVM's symlink and per-user npm installations, then runs Node directly.
An npm command that works in a terminal can still be absent from an already
running BB process. Completely restart BB after changing Node.js, NVM, or PATH.

A bootstrap copy of this customized Preset Sync is included under
`preset/local-plugins/preset-sync`. On a new machine without Preset Sync, install
it from your preset repository, configure the same repository, and preview pull:

```bash
bb plugin install git:https://github.com/YOU/YOUR-PRESET.git@ref:main --subdirectory preset/local-plugins/preset-sync --yes
bb plugin config preset-sync set repositoryUrl https://github.com/YOU/YOUR-PRESET.git
bb preset diff
bb preset pull --yes
```

Replace the example URL and branch with your own. Preset Sync does not replace
its own running code during pull; use `bb plugin update preset-sync` for a
bootstrap installed from Git. Every participating machine needs the version
with local-source support.

Source capture excludes `node_modules`, `dist`, Git history, hidden directories,
environment files, credential files, logs, data/runtime folders, and databases.
Known embedded credential patterns and local dependency references are rejected.
Symlinks, hard links, unsafe paths, and manifest/id mismatches are rejected.
Supported files include TypeScript/JavaScript, JSON, CSS/HTML, Markdown/text,
YAML, shell scripts, SVG/common images, and fonts, plus LICENSE and NOTICE.
Other formats such as WASM and SQL are not captured in this version. Bundles
are limited to 2,000 files and 20 MiB; each file is limited to 5 MiB.

Disabling local-source sync keeps existing remote source bundles. Enabling it
after staging without local sources requires a fresh capture to publish code.

## Captured data

- installed plugins and enabled/disabled state;
- third-party marketplaces;
- general BB settings and experiment flags;
- keyboard shortcut overrides;
- selected theme and favicon color;
- sidebar navigation order and visibility;
- sidebar footer action order and visibility;
- non-secret plugin settings that pass additional safety checks.
- portable local plugin sources and a Preset Sync bootstrap copy.

The plugin does not export saved tokens, API keys, passwords, provider credentials,
sessions, threads, history, databases, runtime state, local marketplaces, or
settings containing machine-local paths. Source files follow the exclusions
and validation described above.

Applying a preset can install full-trust plugins and update BB configuration.
Only sync from a repository you control, inspect changes with `bb preset diff`,
and keep the repository private if its non-secret configuration is sensitive.

## Development

```bash
npm install --include=dev
npm run check
bb plugin install . --yes
```

The MIT-licensed source and prebuilt `dist/` artifacts are committed. BB
installs production dependencies and builds Git installations automatically;
users do not need to run `npm install` manually.
