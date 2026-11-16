# T3 Code patches

Morgan's T3 server and his second T3 Android app run each upstream T3 Code
nightly plus a short list of chosen fixes. Shell issue
[1411](https://github.com/Mgdev-25/shell/issues/1411) holds the plan and the
decisions.

## How it works

- `patches.json` is the list. Upstream PRs come first, each pinned to a head
  SHA with its saved diff in `patches/upstream/`. Own patches follow, each with
  its Shell bug, its check and a `dropWhen` line, in `patches/own/`. At most 8
  own patches, bug fixes only.
- `.github/workflows/nightly.yml` runs with no model. Its cron asks for a run
  every 30 minutes, but GitHub drops most of these runs. So the Shell timer
  `patch-store-gate` on Morgan's PC also starts it for each new nightly with no
  release. For each new upstream nightly it publishes the release `v<version>`:
  - the Linux x64 server archive and `SHA256SUMS`. When a server patch applies,
    it is a build with `PATCHES.json` in the top folder of the archive. Else it
    is a byte-for-byte copy of upstream's archive and checksum file.
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
