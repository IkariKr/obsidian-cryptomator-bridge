# Repository Guidelines

## Project Boundary

- This repository is an Obsidian plugin integration layer, not an encryption product.
- Target Windows desktop only until the project explicitly expands scope.
- Depend on user-installed Cryptomator CLI and WinFsp. Do not bundle, download, install, modify, or reimplement either dependency.
- Support one configured private vault in the first functional release.

## TypeScript and Obsidian

- Use TypeScript and the supported Obsidian plugin API. Keep Electron and Node-specific code behind a desktop-only boundary.
- Prefer small modules with explicit ownership: settings, prerequisite checks, CLI process lifecycle, vault opening, and UI state should not be coupled.
- Do not rely on undocumented Obsidian internals when a supported API or an explicit degraded behavior is available.
- Public APIs, exported types, and compatibility workarounds require concise bilingual comments: Chinese first, English second. Private implementation comments may be Chinese only.

## Cryptomator CLI Boundary

- Invoke the CLI with structured arguments. Never construct shell command strings from user-controlled values.
- Validate configured executable, encrypted-vault, and mount paths before process creation.
- Pass the unlock password only through the child process standard input. Never persist, log, interpolate, copy, or expose it through command-line arguments or environment variables.
- Keep password lifetime minimal and clear references after handing it to the process where JavaScript allows. Do not add password caching, automatic unlock, or keychain storage without an explicit security design review.
- Treat unexpected CLI exit, unavailable WinFsp, inaccessible mount directories, and open file handles during unmount as user-visible recoverable states.

## Testing

- Follow Red -> Green -> Refactor for behavior changes. Add a regression test before fixing a bug when a test seam exists.
- Unit-test path validation, argument construction, redacted diagnostics, state transitions, and error mapping without invoking a real Cryptomator process.
- Keep integration tests opt-in and use disposable test paths. Never place real vault passwords or personal vault paths in fixtures, snapshots, source code, or logs.
