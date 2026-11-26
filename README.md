# T3 Code patches

Morgan's T3 server, his T3 desktop app on Linux and his second T3 Android app
run each upstream T3 Code nightly plus a short list of chosen fixes. Shell issue
[1411](https://github.com/Mgdev-25/shell/issues/1411) holds the plan and the
decisions.

## How it works

- `patches.json` is the list. Upstream PRs come first, each pinned to a head
  SHA with its saved diff in `patches/upstream/`. Own patches follow, each with
  its Shell bug, its check and a `dropWhen` line, in `patches/own/`. At most 12
  own patches, bug fixes only. Morgan allowed these exceptions:
  - `1448-form-free-text-mic`, the mic button in the free-text answer of a
    question form, in Shell issue 1448.
  - `1456-notice-hold`, the child end notice hold, on 2026-11-16 in
    [Shell issue 1456](https://github.com/Mgdev-25/shell/issues/1456).
  - `1474-cleanup-fallback-model`, the fallback model of the voice cleanup,
    on 2026-11-17 in [Shell issue 1210](https://github.com/Mgdev-25/shell/issues/1210#issuecomment-6951291746).
  - `1652-pending-check-poll`, the sweep of watched pull requests every 30
    seconds while a check runs, on 2026-11-24 in
    [Shell issue 1652](https://github.com/Mgdev-25/shell/issues/1652#issuecomment-7130382638).
  - `34-voice-retry`, keeping failed and backgrounded remote phone voice
    recordings with Send again and Discard, on 2026-11-24 in
    [Tasker issue 1273](https://github.com/Mgdev-25/Tasker/issues/1273#issuecomment-7132263804)
    and [t3code-patches issue 34](https://github.com/Mgdev-25/t3code-patches/issues/34).
  - `44-muse-usage-cache`, persisting the latest verified Muse usage limits to
    an atomic JSON cache file across server restarts, on 2026-11-26 in
    [Shell issue 1716](https://github.com/Mgdev-25/shell/issues/1716) and
    [t3code-patches issue 44](https://github.com/Mgdev-25/t3code-patches/issues/44).
- `.github/workflows/nightly.yml` runs with no model. Its cron asks for a run
  every 30 minutes, but GitHub drops most of these runs. So the Shell timer
  `patch-store-gate` on Morgan's PC also starts it for each new nightly with no
  release. For each new upstream nightly it publishes the release `v<version>`:
  - the Linux x64 server archive and `SHA256SUMS`. When a server patch applies,
    it is a build with `PATCHES.json` in the top folder of the archive. Else it
    is a byte-for-byte copy of upstream's archive and checksum file.
  - `T3-Code-Nightly-x86_64.AppImage` and its update manifest
    `nightly-linux.yml`, the Linux x64 desktop app built from the same patched
    tree as the server archive. Its update feed is this repo, so an installed
    store AppImage updates from the store. A release that builds no AppImage,
    because no server patch applies or the build failed, keeps the 2 files of
    the newest store release that has them. So the desktop never sees a new
    version that is not a store build. A failed desktop build sets
    `needsRepair`. [Shell issue 1474](https://github.com/Mgdev-25/shell/issues/1474)
    holds the decisions.
  - `t3code-preview-<version>.apk` when a phone patch applies. Package
    `com.t3tools.t3code.preview`, signed with the store key, with upstream's
    over-the-air updates off.
  - `PATCHES.json`: what was applied, what was left out and why, and notices.
- A patch that does not apply is left out of that release and named in
  `PATCHES.json`. A timer on Morgan's PC reads it and wakes one repair chat,
  which follows `REPAIR.md`.
- A PR that upstream merged into the nightly leaves the list by itself. A PR
  with a new head keeps its pin. A closed PR stays until Morgan decides.
- Releases older than 10 days are deleted. The newest one stays.

## Use

- Server: the systemd drop-in sets
  `T3CODE_RELEASE_BASE_URL=https://github.com/Mgdev-25/t3code-patches/releases/download`.
  Update from the T3 app as usual. T3 checks the SHA-256, runs its preflight and
  goes back to the old version when the new one fails to start.
- Desktop: install a store AppImage one time in place of the upstream one.
  After that, the Update button of the desktop app installs each new store
  build. To go back to plain upstream, install an upstream AppImage again.
- Phone: Obtainium watches this repo's releases and offers each new APK.

## Limits

- An update click in the 10 to 60 minutes after a new upstream nightly can fail
  with HTTP 404. The server keeps its version. A later click works.
- A `t3 update` from a shell without the variable installs the plain upstream
  build.
- A patch that changes the database is refused, because the next plain build
  could not open the database.

## Tests

```bash
node --test scripts/*.test.ts
```
