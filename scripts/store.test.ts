// Run with: node --test scripts/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReport,
  checkAppUpdateYml,
  checkDesktopManifest,
  compareNightly,
  desktopState,
  isPublishedServerBaseline,
  lastDesktopRelease,
  parseUpdateManifest,
  patchChangeLines,
  preserveSameTagMergedNotices,
  previousReportTags,
  releaseNotes,
  partsOf,
  patchPaths,
  refusalOf,
  releasesToPrune,
  selectPreviousBaseline,
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

test("the list allows at most 12 own patches, each with title, summary, check and dropWhen", () => {
  const own = (id: string) => ({ id, bug: 1, file: "f", title: "Title", summary: "Summary.", check: "c", dropWhen: "d" });
  const list: PatchList = {
    keepDays: 10,
    upstream: [],
    own: Array.from({ length: 13 }, (_, index) => own(`p${index}`)),
  };
  assert.match(validateList(list).join(), /cap is 12/);
  assert.deepEqual(validateList({ ...list, own: list.own.slice(0, 12) }), []);
  assert.match(validateList({ ...list, own: [{ ...own("x"), dropWhen: " " }] }).join(), /dropWhen/);
  assert.match(validateList({ ...list, own: [{ ...own("x"), title: " " }] }).join(), /title and a summary/);
  assert.match(validateList({ ...list, own: [{ ...own("x"), title: "Bad *title*" }] }).join(), /'\*'/);
  assert.match(validateList({ ...list, own: [{ ...own("x"), summary: "Line 1\nLine 2" }] }).join(), /single line/);
});

const entry = (pr: number): UpstreamEntry => ({
  pr,
  head: SHA,
  bug: 1,
  file: `p/${pr}.patch`,
  title: `Patch ${pr}`,
  summary: `Fixes ${pr}.`,
});

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
    partsOfEntry: (item) => (item.pr === 4 ? ["mobile"] : ["server"]),
  });
  assert.deepEqual(
    result.keep.map((item) => item.pr),
    [2, 3, 4, 5],
  );
  assert.deepEqual(result.notices, [
    { kind: "merged", pr: 1, tag: "v0.1.10-nightly.20261115.4723", title: "Patch 1", parts: ["server"] },
    { kind: "new-head", pr: 3, head: "c".repeat(40) },
    { kind: "closed", pr: 4, title: "Patch 4", parts: ["mobile"] },
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

test("previousReportTags lists store nightlies strictly older than the target with PATCHES.json newest first", () => {
  const releases = [
    { tagName: "v0.1.12-nightly.20261121.5051", assets: ["PATCHES.json"] },
    { tagName: "v0.1.12-nightly.20261121.5045", assets: ["SHA256SUMS"] },
    { tagName: "v0.1.12-nightly.20261121.5038", assets: ["PATCHES.json"] },
    { tagName: "v0.1.12-nightly.20261121.5024", assets: ["PATCHES.json"] },
  ];
  assert.deepEqual(previousReportTags(releases, "v0.1.12-nightly.20261121.5051"), [
    "v0.1.12-nightly.20261121.5038",
    "v0.1.12-nightly.20261121.5024",
  ]);
  assert.deepEqual(previousReportTags(releases, "v0.1.12-nightly.20261121.5024"), []);
});

test("releaseNotes keeps pure upstream notes when server patches did not change", () => {
  const plan = { needed: true, tag: "v0.1.12-nightly.20261121.5051", version: "0.1.12-nightly.20261121.5051", latest: true };
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261121.5038", version: "0.1.12-nightly.20261121.5038" },
    apply: {
      applied: [
        { id: "pr-25165", parts: ["server"], sha256: "aaaaaaaaaaaa", title: "Muse Code usage limits", summary: "Shows Muse Code usage." },
        { id: "pr-36186", parts: ["mobile"], sha256: "bbbbbbbbbbbb", title: "Remote dictation language", summary: "Sends selected language." },
      ],
      skipped: [
        { id: "pr-36187", reason: "does not apply" },
        { id: "1472-codex-credits", reason: "does not apply", parts: ["server"], title: "Voice cleanup Codex credits", summary: "Keeps Codex Terra while credits remain." },
      ],
      server: true,
      mobile: true,
    },
    notices: [{ kind: "closed", pr: 25165, title: "Muse Code usage limits", parts: ["server"] }],
    server: "built",
    android: "built",
    desktop: "built",
  });
  const current = buildReport({
    plan,
    apply: {
      applied: [
        { id: "pr-25165", parts: ["server"], sha256: "aaaaaaaaaaaa", title: "Muse Code usage limits", summary: "Shows Muse Code usage." },
        // Mobile-only additions, updates, skips, closures, merges, and android build failures stay out of the desktop popup.
        { id: "pr-36186", parts: ["mobile"], sha256: "cccccccccccc", title: "Remote dictation language", summary: "Sends selected language." },
        { id: "1407-notice-link", parts: ["mobile"], sha256: "dddddddddddd", title: "Phone notification deep link", summary: "Opens the tapped chat." },
      ],
      skipped: [
        { id: "1448-form-free-text-mic", reason: "does not apply", parts: ["mobile"], title: "Question form mic button", summary: "Shows mic in form." },
        // Consecutive skip for the same server patch does not repeat in the popup.
        { id: "1472-codex-credits", reason: "does not apply", parts: ["server"], title: "Voice cleanup Codex credits", summary: "Keeps Codex Terra while credits remain." },
      ],
      server: true,
      mobile: true,
    },
    // Repeat closed notice for pr-25165 does not re-emit; mobile merged/closed PRs stay out of desktop popup.
    notices: [
      { kind: "closed", pr: 25165, title: "Muse Code usage limits", parts: ["server"] },
      { kind: "closed", pr: 36186, title: "Remote dictation language", parts: ["mobile"] },
      { kind: "merged", pr: 36187, tag: plan.tag, title: "Mobile dictation tweak", parts: ["mobile"] },
    ],
    server: "built",
    android: "failed",
    desktop: "built",
  });
  assert.deepEqual(patchChangeLines(current, prev), []);
  const notes = releaseNotes(current, { upstreamNotes: UPSTREAM_NOTES, previousReport: prev });
  const beforeDetails = notes.slice(0, notes.indexOf("<details>\n<summary>Full changelog</summary>"));
  assert.doesNotMatch(beforeDetails, /Muse Code|Remote dictation|Phone notification|Question form|Mobile dictation|Store build/);
  assert.match(beforeDetails, /\*\*Queued slash commands\.\*\*/);
  assert.match(notes, /<details>\n<summary>Store patches<\/summary>/);

  // Older PATCHES.json entries without sha256 or title compare by id without false updates,
  // and missing parts on a legacy skipped entry do not leak into the desktop popup.
  const legacyPrev = {
    ...prev,
    applied: [{ id: "pr-25165", parts: ["server"] as const }],
    skipped: [
      { id: "pr-36187", reason: "does not apply" },
      { id: "1472-codex-credits", reason: "does not apply" },
    ],
  };
  assert.deepEqual(patchChangeLines(current, legacyPrev), []);
});

test("releaseNotes adds descriptive upstream-style bullets for changed server patches and combines new closures", () => {
  const plan = { needed: true, tag: "v0.1.12-nightly.20261121.5051", version: "0.1.12-nightly.20261121.5051", latest: true };
  // Legacy previous report (like 5071) lacks title/summary on applied entries; merge notice supplies the title.
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261121.5038", version: "0.1.12-nightly.20261121.5038" },
    apply: {
      applied: [
        { id: "pr-25165", parts: ["server"], sha256: "111111111111" },
        { id: "1456-notice-hold", parts: ["server"], sha256: "222222222222", title: "Child end notice hold", summary: "Groups child end notices up to 120 seconds." },
        { id: "pr-36186", parts: ["mobile"], sha256: "333333333333", title: "Remote dictation language", summary: "Sends selected language." },
      ],
      skipped: [{ id: "pr-99999", reason: "does not apply", parts: ["server"], title: "Old server fix", summary: "Old fix." }],
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
        { id: "pr-39799", parts: ["server"], sha256: "444444444444", title: "Antigravity message queue", summary: "Queues messages while a question waits." },
        { id: "1456-notice-hold", parts: ["server"], sha256: "555555555555", title: "Child end notice hold", summary: "Groups child end notices up to 120 seconds." },
      ],
      skipped: [
        { id: "pr-36186", reason: "does not apply", parts: ["mobile"], title: "Remote dictation language", summary: "Sends selected language." },
        { id: "1472-codex-credits", reason: "does not apply", parts: ["server"], title: "Voice cleanup Codex credits", summary: "Keeps Codex Terra while credits remain." },
      ],
      server: true,
      mobile: false,
    },
    notices: [
      { kind: "merged", pr: 25165, tag: plan.tag, title: "Muse Code usage limits", parts: ["server"] },
      { kind: "closed", pr: 39799, title: "Antigravity message queue", parts: ["server"] },
    ],
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  const bullets = patchChangeLines(current, prev);
  assert.deepEqual(bullets, [
    "- **🟣 Antigravity message queue (closed upstream).** Queues messages while a question waits. Upstream PR closed without merge, review needed.",
    "- **🟣 Child end notice hold (updated).** Groups child end notices up to 120 seconds.",
    "- **🟣 Muse Code usage limits (merged upstream).** Included in upstream T3 Code, store patch dropped.",
    "- **🟣 Old server fix (dropped).** Removed from the store patch list.",
    "- **🟣 Voice cleanup Codex credits (left out).** Not included in this build. Keeps Codex Terra while credits remain.",
  ]);
  const notes = releaseNotes(current, { upstreamNotes: UPSTREAM_NOTES, previousReport: prev });
  assert.ok(
    notes.includes(
      "- **Full file names.** Hover over truncated names in the Files tree.\n" +
        bullets.join("\n") +
        "\n\n### Plus 24 more bug fixes and performance improvements.",
    ),
  );
});

test("store patch bullets start the bold title with a purple dot and match upstream highlight regex", () => {
  const upstreamHighlight = /^\*\*([^*]+)\*\* (.+)$/;
  const plan = { needed: true, tag: "v0.1.12-nightly.20261123.5124", version: "0.1.12-nightly.20261123.5124", latest: true };
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261122.5111", version: "0.1.12-nightly.20261122.5111" },
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: [],
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  const current = buildReport({
    plan,
    apply: {
      applied: [
        {
          id: "1456-notice-hold",
          parts: ["server"],
          sha256: "aaaaaaaaaaaa",
          title: "Child end notice hold",
          summary: "Groups delegated child end notices for an idle parent up to 120 seconds.",
        },
      ],
      skipped: [],
      server: true,
      mobile: false,
    },
    notices: [],
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  const bullets = patchChangeLines(current, prev);
  assert.deepEqual(bullets, [
    "- **🟣 Child end notice hold.** Groups delegated child end notices for an idle parent up to 120 seconds.",
  ]);
  const match = upstreamHighlight.exec(bullets[0]!.replace(/^- /, ""));
  assert.ok(match !== null);
  assert.equal(match[1], "🟣 Child end notice hold.");
  assert.equal(match[2], "Groups delegated child end notices for an idle parent up to 120 seconds.");
});

test("failed server builds emit only the failure bullet, desktop-only failures keep shipped server bullets", () => {
  const plan = { needed: true, tag: "v0.1.12-nightly.20261121.5051", version: "0.1.12-nightly.20261121.5051", latest: true };
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261121.5038", version: "0.1.12-nightly.20261121.5038" },
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: [],
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  const failed = buildReport({
    plan,
    apply: {
      applied: [{ id: "pr-39799", parts: ["server"], sha256: "444444444444", title: "Antigravity message queue", summary: "Queues messages while a question waits." }],
      skipped: [],
      server: true,
      mobile: false,
    },
    notices: [],
    server: "failed",
    android: "not-needed",
    desktop: "failed",
    desktopFrom: "v0.1.12-nightly.20261121.5038",
  });
  assert.equal(isPublishedServerBaseline(prev), true);
  assert.equal(isPublishedServerBaseline(failed), false);
  // Failed server build does not advertise pr-39799 even though apply succeeded.
  assert.deepEqual(patchChangeLines(failed, prev), [
    "- **🟣 Store build failed.** Server and desktop build failed, check the release details.",
  ]);
  // Desktop-only failure still shipped the patched server archive, so it keeps patch bullets plus the failure bullet.
  const desktopOnlyFailed = buildReport({
    plan,
    apply: {
      applied: [{ id: "pr-39799", parts: ["server"], sha256: "444444444444", title: "Antigravity message queue", summary: "Queues messages while a question waits." }],
      skipped: [],
      server: true,
      mobile: false,
    },
    notices: [],
    server: "built",
    android: "not-needed",
    desktop: "failed",
    desktopFrom: "v0.1.12-nightly.20261121.5038",
  });
  assert.equal(isPublishedServerBaseline(desktopOnlyFailed), true);
  assert.deepEqual(patchChangeLines(desktopOnlyFailed, prev), [
    "- **🟣 Antigravity message queue.** Queues messages while a question waits.",
    "- **🟣 Store build failed.** Desktop build failed, check the release details.",
  ]);
  // Without a healthy baseline, a merged mobile PR without server scope stays out of the desktop popup.
  const mergedWithoutBaseline = buildReport({
    plan,
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: [
      { kind: "merged", pr: 36186, tag: plan.tag, title: "Remote dictation language", parts: ["mobile"] },
      { kind: "merged", pr: 25165, tag: plan.tag, title: "Muse Code usage limits", parts: ["server"] },
    ],
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  assert.deepEqual(patchChangeLines(mergedWithoutBaseline, failed), [
    "- **🟣 Muse Code usage limits (merged upstream).** Included in upstream T3 Code, store patch dropped.",
  ]);
  // Carrying merge notices across a failed release preserves "(merged upstream)" on the next healthy release.
  const healthyBefore = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261121.5038", version: "0.1.12-nightly.20261121.5038" },
    apply: {
      applied: [{ id: "pr-25165", parts: ["server"], sha256: "111111111111" }],
      skipped: [],
      server: true,
      mobile: false,
    },
    notices: [],
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  const failedAfterSync = buildReport({
    plan,
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: [{ kind: "merged", pr: 25165, tag: plan.tag, title: "Muse Code usage limits", parts: ["server"] }],
    server: "failed",
    android: "not-needed",
    desktop: "failed",
    desktopFrom: "v0.1.12-nightly.20261121.5038",
  });
  const baseline = selectPreviousBaseline([failedAfterSync, healthyBefore]);
  assert.ok(baseline.baseline !== null);
  const healthyNext = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261122.5072", version: "0.1.12-nightly.20261122.5072" },
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: [],
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  assert.deepEqual(patchChangeLines(healthyNext, baseline), [
    "- **🟣 Muse Code usage limits (merged upstream).** Included in upstream T3 Code, store patch dropped.",
  ]);
  // A replace run for the same tag keeps the older baseline and preserves merge notices from the replaced report.
  const firstRunOfTag = buildReport({
    plan,
    apply: { applied: [], skipped: [{ id: "1456-notice-hold", reason: "does not apply", parts: ["server"], title: "Child end notice hold", summary: "Groups child end notices." }], server: false, mobile: false },
    notices: [{ kind: "merged", pr: 25165, tag: plan.tag, title: "Muse Code usage limits", parts: ["server"] }],
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  const replaceBaseline = selectPreviousBaseline([healthyBefore], firstRunOfTag);
  assert.ok(replaceBaseline.baseline !== null);
  const restoredNotices = preserveSameTagMergedNotices([], replaceBaseline, plan.tag);
  assert.equal(restoredNotices.length, 1);
  const replacedReport = buildReport({
    plan,
    apply: { applied: [{ id: "1456-notice-hold", parts: ["server"], sha256: "222222222222", title: "Child end notice hold", summary: "Groups child end notices." }], skipped: [], server: true, mobile: false },
    notices: restoredNotices,
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  assert.deepEqual(patchChangeLines(replacedReport, replaceBaseline), [
    "- **🟣 Child end notice hold.** Groups child end notices.",
    "- **🟣 Muse Code usage limits (merged upstream).** Included in upstream T3 Code, store patch dropped.",
  ]);
  // A replace run with no older healthy baseline still preserves same-tag merge notices in both bullets and PATCHES.json.
  const replaceNoBaseline = selectPreviousBaseline([], firstRunOfTag);
  assert.equal(replaceNoBaseline.baseline, null);
  const restoredNoBaseline = preserveSameTagMergedNotices([], replaceNoBaseline, plan.tag);
  assert.equal(restoredNoBaseline.length, 1);
  const replacedNoBaselineReport = buildReport({
    plan,
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: restoredNoBaseline,
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  assert.deepEqual(patchChangeLines(replacedNoBaselineReport, replaceNoBaseline), [
    "- **🟣 Muse Code usage limits (merged upstream).** Included in upstream T3 Code, store patch dropped.",
  ]);
});

test("releaseNotes inserts a blank line before bullets when upstream summary has no bullet list", () => {
  const noBullets = `**v0.1.12-nightly.20261122.5072** · 5 changes from 2 contributors

### Plus 5 more bug fixes and performance improvements.

<details>
<summary>Full changelog</summary>

## What's Changed
* fix(server): something
</details>`;
  const plan = { needed: true, tag: "v0.1.12-nightly.20261122.5072", version: "0.1.12-nightly.20261122.5072", latest: true };
  const prev = buildReport({
    plan: { ...plan, tag: "v0.1.12-nightly.20261122.5071", version: "0.1.12-nightly.20261122.5071" },
    apply: { applied: [], skipped: [], server: false, mobile: false },
    notices: [],
    server: "copied",
    android: "not-needed",
    desktop: "not-needed",
  });
  const current = buildReport({
    plan,
    apply: {
      applied: [{ id: "1456-notice-hold", parts: ["server"], sha256: "aaaaaaaaaaaa", title: "Child end notice hold", summary: "Groups child end notices." }],
      skipped: [],
      server: true,
      mobile: false,
    },
    notices: [],
    server: "built",
    android: "not-needed",
    desktop: "built",
  });
  const notes = releaseNotes(current, { upstreamNotes: noBullets, previousReport: prev });
  assert.ok(
    notes.includes(
      "**v0.1.12-nightly.20261122.5072** · 5 changes from 2 contributors\n\n" +
        "- **🟣 Child end notice hold.** Groups child end notices.\n\n" +
        "### Plus 5 more bug fixes and performance improvements.",
    ),
  );
});
