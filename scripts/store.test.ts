// Run with: node --test scripts/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReport,
  checkAppUpdateYml,
  checkDesktopManifest,
  compareNightly,
  desktopState,
  lastDesktopRelease,
  parseUpdateManifest,
  patchChangeLine,
  previousReportTag,
  releaseNotes,
  partsOf,
  patchPaths,
  refusalOf,
  releasesToPrune,
  selectTarget,
  syncEntries,
  validateList,
  type ApplyResult,
  type PatchList,
  type PrState,
  type Release,
  type UpstreamEntry,
} from "./store.ts";

const SHA = "a".repeat(40);
const release = (tagName: string, publishedAt: string): Release => ({ tagName, publishedAt });
const upstream = [
  release("v0.1.10-nightly.20261115.4723", "2026-11-15T05:48:22Z"),
  release("v0.1.10-nightly.20261114.4709", "2026-11-14T23:19:43Z"),
  release("v0.1.9", "2026-11-01T00:00:00Z"),
];

test("plan picks the newest upstream nightly that the store lacks", () => {
  const plan = selectTarget({ upstream, store: [upstream[1]!] });
  assert.deepEqual(plan, {
    needed: true,
    tag: "v0.1.10-nightly.20261115.4723",
    version: "0.1.10-nightly.20261115.4723",
    latest: true,
  });
});

test("plan does nothing when the store has the newest nightly", () => {
  assert.equal(selectTarget({ upstream, store: [upstream[0]!] }).needed, false);
});

test("plan can publish an older nightly that does not become the latest release", () => {
  const plan = selectTarget({ upstream, store: [upstream[0]!], tag: "v0.1.10-nightly.20261114.4709" });
  assert.equal(plan.needed, true);
  assert.equal(plan.latest, false);
});

test("plan refuses a tag that upstream did not publish", () => {
  assert.throws(() => selectTarget({ upstream, store: [], tag: "v0.1.10-nightly.20261116.9999" }));
});

test("replace publishes a nightly again", () => {
  assert.equal(selectTarget({ upstream, store: [upstream[0]!], replace: true }).needed, true);
});

test("nightly order uses the date, then the build number", () => {
  assert.ok(compareNightly("v0.1.10-nightly.20261115.4723", "v0.1.10-nightly.20261114.4730") > 0);
  assert.ok(compareNightly("v0.1.10-nightly.20261115.4700", "v0.1.10-nightly.20261115.4723") < 0);
});

test("parts: the phone app, the server, and docs that need no build", () => {
  assert.deepEqual(partsOf(["apps/mobile/src/a.ts", "docs/x.md"]), ["mobile"]);
  assert.deepEqual(partsOf(["packages/provider-muse/src/a.ts"]), ["server"]);
  assert.deepEqual(partsOf(["apps/mobile/a.ts", "packages/shared/b.ts"]), ["mobile", "server"]);
  assert.deepEqual(partsOf(["docs/user/usage.md"]), []);
});

test("patch paths come from the diff headers, renames give both names", () => {
  const patch = "diff --git a/one.ts b/one.ts\n@@\ndiff --git a/old.ts b/new.ts\n";
  assert.deepEqual(patchPaths(patch), ["one.ts", "old.ts", "new.ts"]);
});

test("a patch that adds a database migration is refused", () => {
  assert.match(refusalOf(["apps/server/src/persistence/Migrations/045_x.ts"]) ?? "", /migration/);
  assert.equal(refusalOf(["apps/server/src/x.ts"]), undefined);
});

test("the list allows at most 8 own patches, each with a check and a drop line", () => {
  const own = (id: string) => ({ id, bug: 1, file: "f", check: "c", dropWhen: "d" });
  const list: PatchList = {
    keepDays: 10,
    upstream: [],
    own: Array.from({ length: 9 }, (_, index) => own(`p${index}`)),
  };
  assert.match(validateList(list).join(), /cap is 8/);
  assert.deepEqual(validateList({ ...list, own: list.own.slice(0, 8) }), []);
  assert.match(validateList({ ...list, own: [{ ...own("x"), dropWhen: " " }] }).join(), /dropWhen/);
});

const entry = (pr: number): UpstreamEntry => ({ pr, head: SHA, bug: 1, file: `p/${pr}.patch` });

test("a PR merged into the tag leaves the list, others stay with notices", () => {
  const states = new Map<number, PrState>([
    [1, { state: "MERGED", headRefOid: "b".repeat(40), mergeCommit: "m1" }],
    [2, { state: "MERGED", headRefOid: SHA, mergeCommit: "m2" }],
    [3, { state: "OPEN", headRefOid: "c".repeat(40), mergeCommit: null }],
    [4, { state: "CLOSED", headRefOid: SHA, mergeCommit: null }],
    [5, { state: "OPEN", headRefOid: SHA, mergeCommit: null }],
  ]);
  const result = syncEntries({
    entries: [1, 2, 3, 4, 5].map(entry),
    states,
    // m2 merged after the tag was cut, so the tag does not hold it yet.
    inTag: (commit) => commit === "m1",
    tag: "v0.1.10-nightly.20261115.4723",
  });
  assert.deepEqual(
    result.keep.map((item) => item.pr),
    [2, 3, 4, 5],
  );
  assert.deepEqual(result.notices, [
    { kind: "merged", pr: 1, tag: "v0.1.10-nightly.20261115.4723" },
    { kind: "new-head", pr: 3, head: "c".repeat(40) },
    { kind: "closed", pr: 4 },
  ]);
});

test("prune keeps the newest release and the last days", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  const releases = [
    release("v0.1.10-nightly.20261115.4723", "2026-11-15T06:00:00Z"),
    release("v0.1.10-nightly.20261114.4709", "2026-11-14T23:30:00Z"),
    release("v0.1.10-nightly.20261113.4630", "2026-11-13T09:00:00Z"),
  ];
  assert.deepEqual(releasesToPrune(releases, now, 10), [
    "v0.1.10-nightly.20261114.4709",
    "v0.1.10-nightly.20261113.4630",
  ]);
  assert.deepEqual(releasesToPrune(releases.slice(0, 1), new Date("2027-01-01T00:00:00Z"), 10), []);
});

test("the report asks for a repair on a skipped patch, a failed build or a closed PR", () => {
  const plan = { needed: true, tag: "v0.1.10-nightly.20261115.4723", version: "0.1.10-nightly.20261115.4723", latest: true };
  const clean: ApplyResult = { applied: [{ id: "pr-1", parts: ["server"] }], skipped: [], server: true, mobile: false };
  const base = { plan, apply: clean, notices: [], server: "built", android: "not-needed", desktop: "built" } as const;
  assert.equal(buildReport(base).needsRepair, false);
  assert.equal(buildReport({ ...base, notices: [{ kind: "new-head", pr: 1, head: SHA }] }).needsRepair, false);
  assert.equal(buildReport({ ...base, notices: [{ kind: "closed", pr: 1 }] }).needsRepair, true);
  assert.equal(buildReport({ ...base, server: "failed" }).needsRepair, true);
  assert.equal(buildReport({ ...base, desktop: "failed" }).needsRepair, true);
  assert.equal(buildReport({ ...base, desktop: "not-needed" }).needsRepair, false);
  assert.equal(
    buildReport({ ...base, apply: { ...clean, skipped: [{ id: "x", reason: "does not apply" }] } }).needsRepair,
    true,
  );
});

test("the desktop is built only after a server build, else it keeps the last store files", () => {
  assert.equal(desktopState("success", "success"), "built");
  assert.equal(desktopState("success", "failure"), "failed");
  assert.equal(desktopState("success", "cancelled"), "failed");
  // A failed server build skips the desktop job: the desktop also failed.
  assert.equal(desktopState("failure", "skipped"), "failed");
  // No server patch: nothing to build, and no repair.
  assert.equal(desktopState("skipped", "skipped"), "not-needed");
});

test("a release that builds no desktop app keeps the files of the newest store release that has them", () => {
  const both = ["T3-Code-Nightly-x86_64.AppImage", "nightly-linux.yml", "SHA256SUMS"];
  const releases = [
    { tagName: "v0.1.11-nightly.20261119.4918", assets: both },
    { tagName: "v0.1.11-nightly.20261118.4903", assets: ["nightly-linux.yml"] },
    { tagName: "v0.1.11-nightly.20261118.4890", assets: both },
    { tagName: "v0.1.11-nightly.20261117.4864", assets: both },
  ];
  // The release of the run itself never counts, also when a replace run publishes it again.
  assert.equal(lastDesktopRelease(releases, "v0.1.11-nightly.20261119.4918"), "v0.1.11-nightly.20261118.4890");
  assert.equal(lastDesktopRelease(releases, "v0.1.11-nightly.20261120.5000"), "v0.1.11-nightly.20261119.4918");
  assert.equal(lastDesktopRelease(releases.slice(1, 2), "v0.1.11-nightly.20261120.5000"), undefined);
});

// Upstream's nightly-linux.yml of v0.1.11-nightly.20261119.4918.
const MANIFEST = `version: 0.1.11-nightly.20261119.4918
files:
  - url: T3-Code-Nightly-x86_64.AppImage
    sha512: EjCW+lCFUMyf/HZ2xxWJhg+lfaCgnic2v7c1nUyn20nFBdFtfuRfV4v2qBTW9/WwEDGIEE09frkcfi6XcPYthg==
    size: 256033014
    blockMapSize: 268026
  - url: T3-Code-0.1.11-nightly.20261119.4918-amd64.deb
    sha512: 4jAbGfsQjGG3X3IIWFDH6SVXAojAjHmgNMsZHq3UH0a3lzxH77LXtlEuPsDfXgffp0oD/J/J5ECEsOnUNiKOlg==
    size: 212362492
path: T3-Code-Nightly-x86_64.AppImage
sha512: EjCW+lCFUMyf/HZ2xxWJhg+lfaCgnic2v7c1nUyn20nFBdFtfuRfV4v2qBTW9/WwEDGIEE09frkcfi6XcPYthg==
releaseDate: '2026-11-19T05:19:50.032Z'
`;

test("the desktop manifest names the version, and the sha512 and size of the AppImage", () => {
  const manifest = parseUpdateManifest(MANIFEST);
  assert.equal(manifest.version, "0.1.11-nightly.20261119.4918");
  assert.equal(manifest.files.length, 2);
  const appImage = {
    sha512: "EjCW+lCFUMyf/HZ2xxWJhg+lfaCgnic2v7c1nUyn20nFBdFtfuRfV4v2qBTW9/WwEDGIEE09frkcfi6XcPYthg==",
    size: 256033014,
  };
  assert.deepEqual(checkDesktopManifest(manifest, "0.1.11-nightly.20261119.4918", appImage), []);
  assert.match(checkDesktopManifest(manifest, "0.1.11-nightly.20261120.5000", appImage).join(), /version/);
  assert.match(checkDesktopManifest(manifest, manifest.version, { ...appImage, size: 1 }).join(), /size/);
  assert.equal(checkDesktopManifest(manifest, manifest.version, { ...appImage, sha512: "x" }).length, 2);
});

test("the AppImage of the store updates from the store repo on the nightly channel", () => {
  const yml = "owner: Mgdev-25\nrepo: t3code-patches\nprovider: github\nreleaseType: prerelease\nchannel: nightly\nupdaterCacheDirName: t3code-updater\n";
  assert.deepEqual(checkAppUpdateYml(yml, "Mgdev-25/t3code-patches"), []);
  assert.match(checkAppUpdateYml(yml.replace("Mgdev-25", "pingdotgg").replace("t3code-patches", "t3code"), "Mgdev-25/t3code-patches").join(), /feed/);
  assert.match(checkAppUpdateYml(yml.replace("channel: nightly", "channel: latest"), "Mgdev-25/t3code-patches").join(), /channel/);
});

test("the notes name the desktop state and the release whose files it keeps", () => {
  const plan = { needed: true, tag: "v0.1.11-nightly.20261119.4918", version: "0.1.11-nightly.20261119.4918", latest: true };
  const apply: ApplyResult = { applied: [], skipped: [], server: true, mobile: false };
  const report = buildReport({
    plan, apply, notices: [], server: "built", android: "not-needed", desktop: "failed", desktopFrom: "v0.1.11-nightly.20261118.4903",
  });
  assert.equal(report.desktopFrom, "v0.1.11-nightly.20261118.4903");
  assert.match(releaseNotes(report), /Desktop AppImage: failed, files of v0\.1\.11-nightly\.20261118\.4903\./);
  const built = buildReport({ plan, apply, notices: [], server: "built", android: "not-needed", desktop: "built", desktopFrom: "x" });
  assert.equal(built.desktopFrom, null);
});

const UPSTREAM_NOTES = `**v0.1.12-nightly.20261121.5051** · 38 changes from 9 contributors

- **Queued slash commands.** Send slash commands while an agent is working.
- **Full file names.** Hover over truncated names in the Files tree.

### Plus 24 more bug fixes and performance improvements.

<details>
<summary>Full changelog</summary>

## What's Changed
* fix(server): something
</details>`;

test("previousReportTag picks the newest store nightly strictly older than the target with PATCHES.json", () => {
  const releases = [
    { tagName: "v0.1.12-nightly.20261121.5051", assets: ["PATCHES.json"] },
    { tagName: "v0.1.12-nightly.20261121.5045", assets: ["SHA256SUMS"] },
    { tagName: "v0.1.12-nightly.20261121.5038", assets: ["PATCHES.json"] },
    { tagName: "v0.1.12-nightly.20261121.5024", assets: ["PATCHES.json"] },
  ];
  assert.equal(previousReportTag(releases, "v0.1.12-nightly.20261121.5051"), "v0.1.12-nightly.20261121.5038");
  assert.equal(previousReportTag(releases, "v0.1.12-nightly.20261121.5024"), undefined);
});

test("releaseNotes keeps pure upstream notes when patches did not change", () => {
  const plan = { needed: true, tag: "v0.1.12-nightly.20261121.5051", version: "0.1.12-nightly.20261121.5051", latest: true };
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261121.5038", version: "0.1.12-nightly.20261121.5038" },
    apply: { applied: [{ id: "pr-25165", parts: ["server"], sha256: "aaaaaaaaaaaa" }], skipped: [], server: true, mobile: false },
    notices: [],
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  const current = buildReport({
    plan,
    apply: { applied: [{ id: "pr-25165", parts: ["server"], sha256: "aaaaaaaaaaaa" }], skipped: [], server: true, mobile: false },
    notices: [],
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  assert.equal(patchChangeLine(current, prev), null);
  const notes = releaseNotes(current, { upstreamNotes: UPSTREAM_NOTES, previousReport: prev });
  const beforeDetails = notes.slice(0, notes.indexOf("<details>\n<summary>Full changelog</summary>"));
  assert.doesNotMatch(beforeDetails, /Store patches updated/);
  assert.match(beforeDetails, /\*\*Queued slash commands\.\*\*/);
  assert.match(notes, /<details>\n<summary>Store patches<\/summary>/);

  // Older PATCHES.json entries without sha256 compare by id without false updates.
  const legacyPrev = { ...prev, applied: [{ id: "pr-25165", parts: ["server"] as const }] };
  assert.equal(patchChangeLine(current, legacyPrev), null);
});

test("releaseNotes adds one upstream-style bullet when patches are added, updated, dropped, or fail", () => {
  const plan = { needed: true, tag: "v0.1.12-nightly.20261121.5051", version: "0.1.12-nightly.20261121.5051", latest: true };
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261121.5038", version: "0.1.12-nightly.20261121.5038" },
    apply: {
      applied: [
        { id: "pr-25165", parts: ["server"], sha256: "111111111111" },
        { id: "1456-notice-hold", parts: ["server"], sha256: "222222222222" },
        { id: "pr-36186", parts: ["mobile"], sha256: "333333333333" },
      ],
      skipped: [{ id: "pr-99999", reason: "does not apply" }],
      server: true,
      mobile: true,
    },
    notices: [],
    server: "built",
    android: "built",
    desktop: "built",
  });
  const current = buildReport({
    plan,
    apply: {
      applied: [
        { id: "pr-39799", parts: ["server"], sha256: "444444444444" },
        { id: "1456-notice-hold", parts: ["server"], sha256: "555555555555" },
      ],
      skipped: [{ id: "pr-36186", reason: "does not apply" }],
      server: true,
      mobile: false,
    },
    notices: [{ kind: "merged", pr: 25165, tag: plan.tag }],
    server: "built",
    android: "not-needed",
    desktop: "failed",
    desktopFrom: "v0.1.12-nightly.20261121.5038",
  });
  const bullet = patchChangeLine(current, prev);
  assert.equal(
    bullet,
    "- **Store patches updated.** Added pr-39799, updated 1456-notice-hold, dropped pr-25165, pr-99999, left out pr-36186, desktop build failed.",
  );
  const notes = releaseNotes(current, { upstreamNotes: UPSTREAM_NOTES, previousReport: prev });
  assert.ok(
    notes.includes(
      "- **Full file names.** Hover over truncated names in the Files tree.\n" +
        "- **Store patches updated.** Added pr-39799, updated 1456-notice-hold, dropped pr-25165, pr-99999, left out pr-36186, desktop build failed.\n\n" +
        "### Plus 24 more bug fixes and performance improvements.",
    ),
  );
});
