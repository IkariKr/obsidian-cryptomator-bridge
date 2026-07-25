# Repository Guidelines

## Project Boundary

- This repository is an Obsidian plugin integration layer, not an encryption product.
- Target Windows desktop only until the project explicitly expands scope.
- Depend on user-installed Cryptomator Desktop, Cryptomator CLI, and WinFsp. Do not bundle, download, install, modify, or reimplement any dependency.
- Support folder-scoped Cryptomator Vault records in the first functional release. The bridge and Nutstore plugin run in the control Vault; unlocking exposes each plaintext mount as a sibling directory in that same Vault.
- Treat a selected folder's “encryption” as onboarding or migration into a separate Cryptomator Vault, never in-place encryption. Vault creation remains a Cryptomator Desktop responsibility; any source deletion requires explicit confirmation after copy verification.
- With the Nutstore Obsidian WebDAV plugin, the encrypted Vault must be inside the current control Vault's synced scope, while the plaintext sibling mount uses the reserved `.cryptomator-mount` suffix and is excluded by the fixed rule `**/*.cryptomator-mount`. Never rely on an unverified or undocumented sync exclusion; the rule must be configured before unlock on every device. Cryptomator encrypts writes continuously; locking only unmounts the plaintext view.

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
- Automatic locking after system idle time or Windows lock-screen is in scope. It must use the same safe unmount path as a manual lock and surface an unmount failure as recoverable; it must never imply that files were re-encrypted at lock time.
- Treat unexpected CLI exit, unavailable WinFsp, inaccessible mount directories, and open file handles during unmount as user-visible recoverable states.

## Testing

- Follow Red -> Green -> Refactor for behavior changes. Add a regression test before fixing a bug when a test seam exists.
- Unit-test path validation, argument construction, redacted diagnostics, state transitions, and error mapping without invoking a real Cryptomator process.
- Keep integration tests opt-in and use disposable test paths. Never place real vault passwords or personal vault paths in fixtures, snapshots, source code, or logs.
