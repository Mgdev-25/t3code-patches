// Patch store for T3 Code. One script with no model, run by .github/workflows/nightly.yml.
//
// Commands:
//   plan    --out <file> [--tag <tag>] [--replace]   pick the upstream nightly to publish
//   sync    --tag <tag> --notices <file>             drop merged PRs from patches.json
//   apply   --src <dir> --out <file> [--skip a,b]    apply the list to an upstream checkout
//   marker  --archive <file> --report <file>         put PATCHES.json in a built server archive
//   desktop-state  --server <result> --desktop <result>  the desktop state from the 2 job results
//   desktop-source --tag <tag>                       the store release whose desktop files to keep
//   desktop-check  --dir <dir> --version <v> --app-update <file>  check a built desktop app
//   previous-report --tag <tag> --out <file>         download PATCHES.json of the prior store release
//   report  --plan <f> --apply <f> --notices <f> --server <state> --android <state>
//           --desktop <state> [--desktop-from <tag>] [--upstream-notes <f>] [--prev-report <f>] --out <dir>
//   prune   --keep-days <n>                          delete store releases older than n days
//
// Each command prints one JSON line. The pure functions below have tests in store.test.ts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const UPSTREAM = "pingdotgg/t3code";
export const MAX_OWN_PATCHES = 10;
export const NIGHTLY_TAG = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/;
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations/";

export interface UpstreamEntry {
  readonly pr: number;
  readonly head: string;
  readonly bug: number;
  readonly file: string;
  readonly title: string;
  readonly summary: string;
}

export interface OwnEntry {
  readonly id: string;
  readonly bug: number;
  readonly file: string;
  readonly title: string;
  readonly summary: string;
  readonly check: string;
  readonly dropWhen: string;
}

export interface PatchList {
  readonly keepDays: number;
  readonly upstream: ReadonlyArray<UpstreamEntry>;
  readonly own: ReadonlyArray<OwnEntry>;
}

export type Part = "server" | "mobile";

export interface Applied {
  readonly id: string;
  readonly parts: ReadonlyArray<Part>;
  /** First 12 hex chars of the patch file's SHA-256, so release notes spot rebased patches. */
  readonly sha256?: string;
  readonly title?: string;
  readonly summary?: string;
}

export interface Skipped {
  readonly id: string;
  readonly reason: string;
  readonly parts?: ReadonlyArray<Part>;
  readonly title?: string;
  readonly summary?: string;
}

export interface ApplyResult {
  readonly applied: ReadonlyArray<Applied>;
  readonly skipped: ReadonlyArray<Skipped>;
  readonly server: boolean;
  readonly mobile: boolean;
}

export interface Release {
  readonly tagName: string;
  readonly publishedAt: string;
  readonly isDraft?: boolean;
}

export interface Plan {
  readonly needed: boolean;
  readonly tag: string;
  readonly version: string;
  readonly latest: boolean;
}

export interface PrState {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly headRefOid: string;
  readonly mergeCommit: string | null;
}

export type Notice =
  | {
      readonly kind: "merged";
      readonly pr: number;
      readonly tag: string;
      readonly title?: string;
      readonly parts?: ReadonlyArray<Part>;
    }
  | { readonly kind: "new-head"; readonly pr: number; readonly head: string }
  | {
      readonly kind: "closed";
      readonly pr: number;
      readonly title?: string;
      readonly parts?: ReadonlyArray<Part>;
    };

export type MergedNotice = Extract<Notice, { readonly kind: "merged" }>;

/** The id of a list entry, as the report and the --skip input name it. */
export const entryId = (entry: UpstreamEntry | OwnEntry): string =>
  "pr" in entry ? `pr-${entry.pr}` : entry.id;

/** Upstream PRs first, then own patches, each in list order. Own patches can build on PRs. */
export const applyOrder = (list: PatchList): ReadonlyArray<UpstreamEntry | OwnEntry> => [
  ...list.upstream,
  ...list.own,
];

export function validateList(list: PatchList): ReadonlyArray<string> {
  const errors: string[] = [];
  if (list.own.length > MAX_OWN_PATCHES) {
    errors.push(`${list.own.length} own patches, the cap is ${MAX_OWN_PATCHES}`);
  }
  const ids = applyOrder(list).map(entryId);
  for (const id of new Set(ids)) {
    if (ids.filter((other) => other === id).length > 1) errors.push(`duplicate entry ${id}`);
  }
  for (const entry of list.upstream) {
    if (!/^[0-9a-f]{40}$/.test(entry.head)) errors.push(`pr-${entry.pr} head is not a full SHA`);
  }
  for (const entry of list.own) {
    if (!entry.check.trim() || !entry.dropWhen.trim()) {
      errors.push(`${entry.id} needs a check and a dropWhen line`);
    }
  }
  for (const entry of applyOrder(list)) {
    const id = entryId(entry);
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
    if (!title || !summary) {
      errors.push(`${id} needs a title and a summary`);
    } else {
      if (/[*\r\n]/.test(title)) errors.push(`${id} title cannot contain '*' or newlines`);
      if (/[\r\n]/.test(summary)) errors.push(`${id} summary must be a single line`);
    }
  }
  return errors;
}

/** The paths that a unified diff changes, from its `diff --git a/x b/y` lines. */
export function patchPaths(patch: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    paths.add(match[1]!);
    paths.add(match[2]!);
  }
  return [...paths];
}

/** Which build a patch needs. Docs change no build; `apps/mobile` is the phone; the rest is the server. */
export function partsOf(paths: ReadonlyArray<string>): ReadonlyArray<Part> {
  const parts = new Set<Part>();
  for (const path of paths) {
    if (path.startsWith("docs/") || path.endsWith(".md")) continue;
    parts.add(path.startsWith("apps/mobile/") ? "mobile" : "server");
  }
  return [...parts].sort();
}

/** A reason to refuse a patch before it is applied, or undefined. */
export function refusalOf(paths: ReadonlyArray<string>): string | undefined {
  return paths.some((path) => path.startsWith(MIGRATIONS_DIR))
    ? "adds a database migration, which blocks the next plain build"
    : undefined;
}

/**
 * The nightly to publish. With no `tag`, the newest published upstream nightly. It is needed
 * when the store has no release of it yet, or when `replace` asks to publish it again.
 */
export function selectTarget(input: {
  readonly upstream: ReadonlyArray<Release>;
  readonly store: ReadonlyArray<Release>;
  readonly tag?: string;
  readonly replace?: boolean;
}): Plan {
  const nightlies = input.upstream
    .filter((release) => !release.isDraft && NIGHTLY_TAG.test(release.tagName))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const newest = nightlies[0];
  if (newest === undefined) throw new Error("upstream has no published nightly");
  const tag = input.tag?.trim() || newest.tagName;
  const version = NIGHTLY_TAG.exec(tag)?.[1];
  if (version === undefined) throw new Error(`${tag} is not a nightly tag`);
  if (!nightlies.some((release) => release.tagName === tag)) {
    throw new Error(`upstream has no published release ${tag}`);
  }
  const published = input.store.some((release) => release.tagName === tag);
  const newerInStore = input.store.some(
    (release) => NIGHTLY_TAG.test(release.tagName) && compareNightly(release.tagName, tag) > 0,
  );
  return {
    needed: !published || input.replace === true,
    tag,
    version,
    latest: tag === newest.tagName && !newerInStore,
  };
}

/** Orders 2 nightly tags by date, then by build number. */
export function compareNightly(a: string, b: string): number {
  const key = (tag: string) => {
    const match = /-nightly\.(\d{8})\.(\d+)$/.exec(tag);
    if (match === null) throw new Error(`${tag} is not a nightly tag`);
    return [Number(match[1]), Number(match[2])] as const;
  };
  const [dateA, buildA] = key(a);
  const [dateB, buildB] = key(b);
  return dateA - dateB || buildA - buildB;
}

/**
 * The list after an upstream nightly. A PR merged into `tag` leaves the list. The merge is read
 * from the PR state and its merge commit, because a squash merge does not keep the head SHA.
 * A PR with a new head keeps its pin. A closed PR stays until Morgan decides.
 */
export function syncEntries(input: {
  readonly entries: ReadonlyArray<UpstreamEntry>;
  readonly states: ReadonlyMap<number, PrState>;
  readonly inTag: (mergeCommit: string) => boolean;
  readonly tag: string;
  readonly partsOfEntry?: (entry: UpstreamEntry) => ReadonlyArray<Part> | undefined;
}): { readonly keep: ReadonlyArray<UpstreamEntry>; readonly notices: ReadonlyArray<Notice> } {
  const keep: UpstreamEntry[] = [];
  const notices: Notice[] = [];
  for (const entry of input.entries) {
    const state = input.states.get(entry.pr);
    if (state === undefined) throw new Error(`no state for PR ${entry.pr}`);
    const title = entry.title.trim();
    const parts = input.partsOfEntry?.(entry);
    if (state.state === "MERGED" && state.mergeCommit !== null && input.inTag(state.mergeCommit)) {
      notices.push({
        kind: "merged",
        pr: entry.pr,
        tag: input.tag,
        ...(title ? { title } : {}),
        ...(parts !== undefined ? { parts } : {}),
      });
      continue;
    }
    keep.push(entry);
    if (state.state === "CLOSED") {
      notices.push({
        kind: "closed",
        pr: entry.pr,
        ...(title ? { title } : {}),
        ...(parts !== undefined ? { parts } : {}),
      });
    } else if (state.state === "OPEN" && state.headRefOid !== entry.head) {
      notices.push({ kind: "new-head", pr: entry.pr, head: state.headRefOid });
    }
  }
  return { keep, notices };
}

/** Store releases to delete: nightlies older than `keepDays`, never the newest one. */
export function releasesToPrune(
  releases: ReadonlyArray<Release>,
  now: Date,
  keepDays: number,
): ReadonlyArray<string> {
  const nightlies = releases
    .filter((release) => NIGHTLY_TAG.test(release.tagName))
    .sort((a, b) => compareNightly(b.tagName, a.tagName));
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return nightlies
    .slice(1)
    .filter((release) => Date.parse(release.publishedAt) < cutoff)
    .map((release) => release.tagName);
}

export type BuildState = "built" | "copied" | "failed" | "not-needed";

/** A GitHub Actions job result, as `needs.<job>.result` gives it. */
export type JobResult = "success" | "failure" | "cancelled" | "skipped";

/** The Linux x64 desktop files of a release. electron-updater reads the manifest, then the AppImage. */
export const DESKTOP_APPIMAGE = "T3-Code-Nightly-x86_64.AppImage";
export const DESKTOP_MANIFEST = "nightly-linux.yml";
export const DESKTOP_FILES: ReadonlyArray<string> = [DESKTOP_APPIMAGE, DESKTOP_MANIFEST];

/**
 * The desktop state of a release. The desktop job packages the bundle of the server job, so it
 * runs only after a server build. With no server patch there is nothing to build: the release
 * keeps the desktop files of the last store release, as it does after a failed build.
 */
export function desktopState(server: JobResult, desktop: JobResult): BuildState {
  if (server === "skipped") return "not-needed";
  return server === "success" && desktop === "success" ? "built" : "failed";
}

export interface ReleaseAssets {
  readonly tagName: string;
  readonly assets: ReadonlyArray<string>;
}

/** The newest store nightly other than `tag` that holds both desktop files, or undefined. */
export function lastDesktopRelease(releases: ReadonlyArray<ReleaseAssets>, tag: string): string | undefined {
  return releases
    .filter((release) => release.tagName !== tag && NIGHTLY_TAG.test(release.tagName))
    .filter((release) => DESKTOP_FILES.every((file) => release.assets.includes(file)))
    .sort((a, b) => compareNightly(b.tagName, a.tagName))[0]?.tagName;
}

export interface ManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export interface UpdateManifest {
  readonly version: string;
  readonly path: string;
  readonly sha512: string;
  readonly files: ReadonlyArray<ManifestFile>;
}

/**
 * Reads the few fields of an electron-builder update manifest that the store checks. The file is
 * flat YAML: top keys, and a `files` list of `- url:` entries with indented keys.
 */
export function parseUpdateManifest(text: string): UpdateManifest {
  const top: Record<string, string> = {};
  const files: Array<Record<string, string>> = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s+-\s+(\w+):\s*(.*)$/.exec(line);
    const field = /^\s+(\w+):\s*(.*)$/.exec(line);
    const key = /^(\w+):\s*(.*)$/.exec(line);
    if (entry !== null) files.push({ [entry[1]!]: unquote(entry[2]!) });
    else if (field !== null && files.length > 0) files[files.length - 1]![field[1]!] = unquote(field[2]!);
    else if (key !== null) top[key[1]!] = unquote(key[2]!);
  }
  return {
    version: top.version ?? "",
    path: top.path ?? "",
    sha512: top.sha512 ?? "",
    files: files.map((file) => ({ url: file.url ?? "", sha512: file.sha512 ?? "", size: Number(file.size) })),
  };
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/** What is wrong with a built desktop manifest for the AppImage `appImage` of `version`. */
export function checkDesktopManifest(
  manifest: UpdateManifest,
  version: string,
  appImage: { readonly sha512: string; readonly size: number },
): ReadonlyArray<string> {
  const errors: string[] = [];
  if (manifest.version !== version) errors.push(`manifest version ${manifest.version}, expected ${version}`);
  if (manifest.path !== DESKTOP_APPIMAGE) errors.push(`manifest path ${manifest.path}, expected ${DESKTOP_APPIMAGE}`);
  if (manifest.sha512 !== appImage.sha512) errors.push("manifest sha512 does not match the AppImage");
  const file = manifest.files.find((item) => item.url === DESKTOP_APPIMAGE);
  if (file === undefined) errors.push(`manifest lists no ${DESKTOP_APPIMAGE}`);
  else {
    if (file.sha512 !== appImage.sha512) errors.push("files entry sha512 does not match the AppImage");
    if (file.size !== appImage.size) errors.push(`files entry size ${file.size}, the AppImage has ${appImage.size}`);
  }
  return errors;
}

/**
 * What is wrong with the app-update.yml inside the AppImage. It must name the store repo, so an
 * installed store build keeps updating from the store, and the nightly channel.
 */
export function checkAppUpdateYml(text: string, repo: string): ReadonlyArray<string> {
  const fields = new Map<string, string>();
  for (const match of text.matchAll(/^(\w+):\s*(.*)$/gm)) fields.set(match[1]!, unquote(match[2]!));
  const [owner, name] = repo.split("/");
  const errors: string[] = [];
  if (fields.get("provider") !== "github") errors.push(`provider ${fields.get("provider")}, expected github`);
  if (fields.get("owner") !== owner || fields.get("repo") !== name) {
    errors.push(`feed ${fields.get("owner")}/${fields.get("repo")}, expected ${repo}`);
  }
  if (fields.get("channel") !== "nightly") errors.push(`channel ${fields.get("channel")}, expected nightly`);
  return errors;
}

export interface Report {
  readonly version: string;
  readonly upstreamTag: string;
  readonly server: BuildState;
  readonly android: BuildState;
  readonly desktop: BuildState;
  /** The store release whose desktop files this release keeps, when it did not build its own. */
  readonly desktopFrom: string | null;
  readonly applied: ReadonlyArray<Applied>;
  readonly skipped: ReadonlyArray<Skipped>;
  readonly notices: ReadonlyArray<Notice>;
  /** True when a repair chat has work: a skipped patch, a failed build or a closed PR. */
  readonly needsRepair: boolean;
}

/** Prior healthy desktop baseline plus merged notices carried across failed or replaced runs. */
export interface PreviousContext {
  readonly baseline: Report | null;
  readonly carriedMergedNotices: ReadonlyArray<MergedNotice>;
}

export function buildReport(input: {
  readonly plan: Plan;
  readonly apply: ApplyResult;
  readonly notices: ReadonlyArray<Notice>;
  readonly server: BuildState;
  readonly android: BuildState;
  readonly desktop: BuildState;
  readonly desktopFrom?: string | undefined;
}): Report {
  return {
    version: input.plan.version,
    upstreamTag: input.plan.tag,
    server: input.server,
    android: input.android,
    desktop: input.desktop,
    desktopFrom: input.desktop === "built" ? null : (input.desktopFrom ?? null),
    applied: input.apply.applied,
    skipped: input.apply.skipped,
    notices: input.notices,
    needsRepair:
      input.apply.skipped.length > 0 ||
      input.server === "failed" ||
      input.android === "failed" ||
      input.desktop === "failed" ||
      input.notices.some((notice) => notice.kind === "closed"),
  };
}

/** Store nightlies strictly older than `tag` that hold PATCHES.json, newest first. */
export function previousReportTags(releases: ReadonlyArray<ReleaseAssets>, tag: string): ReadonlyArray<string> {
  return releases
    .filter((release) => NIGHTLY_TAG.test(release.tagName) && compareNightly(release.tagName, tag) < 0)
    .filter((release) => release.assets.includes("PATCHES.json"))
    .sort((a, b) => compareNightly(b.tagName, a.tagName))
    .map((release) => release.tagName);
}

/** True when a release shipped a non-failed server build (or clean upstream copy). */
export const isPublishedServerBaseline = (report: Report): boolean => report.server !== "failed";

/**
 * Picks the newest prior report whose server build did not fail as the baseline and carries
 * forward any `merged` notices from a same-tag release being replaced and from failed releases
 * skipped along the way, even when no older healthy baseline exists.
 */
export function selectPreviousBaseline(
  reports: ReadonlyArray<Report>,
  sameTagReport?: Report | null,
): PreviousContext {
  const carried: MergedNotice[] = [];
  const collectMerged = (report: Report) => {
    for (const notice of report.notices) {
      if (notice.kind === "merged") carried.push(notice);
    }
  };
  if (sameTagReport !== null && sameTagReport !== undefined) {
    collectMerged(sameTagReport);
  }
  let baseline: Report | null = null;
  for (const report of reports) {
    if (isPublishedServerBaseline(report)) {
      baseline = report;
      break;
    }
    collectMerged(report);
  }
  const seen = new Set<number>();
  const carriedMergedNotices = carried.filter((notice) => {
    if (seen.has(notice.pr)) return false;
    seen.add(notice.pr);
    return true;
  });
  return { baseline, carriedMergedNotices };
}

function normalizePrevious(previous?: Report | PreviousContext | null): PreviousContext {
  if (previous === null || previous === undefined) {
    return { baseline: null, carriedMergedNotices: [] };
  }
  if ("baseline" in previous) {
    return {
      baseline:
        previous.baseline !== null && isPublishedServerBaseline(previous.baseline)
          ? previous.baseline
          : null,
      carriedMergedNotices: previous.carriedMergedNotices,
    };
  }
  return {
    baseline: isPublishedServerBaseline(previous) ? previous : null,
    carriedMergedNotices: [],
  };
}

/** Keeps merged notices recorded for `tag` on an earlier run when a `replace` run republishes `tag`. */
export function preserveSameTagMergedNotices(
  notices: ReadonlyArray<Notice>,
  previous: Report | PreviousContext | null | undefined,
  tag: string,
): ReadonlyArray<Notice> {
  const existing = new Set(
    notices.filter((notice) => notice.kind === "merged").map((notice) => notice.pr),
  );
  const restored = normalizePrevious(previous).carriedMergedNotices.filter(
    (notice) => notice.tag === tag && !existing.has(notice.pr),
  );
  return restored.length > 0 ? [...notices, ...restored] : notices;
}

const FULL_CHANGELOG_MARKER = /<details>\s*<summary>\s*Full changelog\s*<\/summary>/i;

interface PatchMeta {
  readonly parts?: ReadonlyArray<Part> | undefined;
  readonly title?: string | undefined;
}

const hasServerPart = (parts?: ReadonlyArray<Part>): boolean =>
  parts !== undefined && parts.includes("server");

const ensurePeriod = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

function formatPatchBullet(title: string, body: string): string {
  const cleanTitle = title.trim().replace(/\.+$/, "").replace(/\*/g, "");
  return `- **🟣 ${cleanTitle}.** ${ensurePeriod(body)}`;
}

function mergeMeta(...sources: ReadonlyArray<PatchMeta | undefined>): PatchMeta {
  return {
    parts: sources.find((source) => source?.parts !== undefined)?.parts,
    title: sources.find((source) => source?.title?.trim())?.title,
  };
}

/**
 * Upstream-style `- **🟣 Title.** Description.` bullets for server and desktop patches that changed
 * compared to the previous published store build, were left out, newly closed upstream, or failed
 * to build. Mobile-only patches stay in PATCHES.json and the collapsed Store patches block. Empty
 * when clean and unchanged so the desktop update notice stays pure upstream T3 Code notes.
 */
export function patchChangeLines(
  report: Report,
  previous?: Report | PreviousContext | null,
): ReadonlyArray<string> {
  if (report.server === "failed") {
    const label = report.desktop === "failed" ? "Server and desktop" : "Server";
    return [
      formatPatchBullet(
        "Store build failed",
        `${label} build failed, check the release details.`,
      ),
    ];
  }

  const { baseline, carriedMergedNotices } = normalizePrevious(previous);

  const bullets: string[] = [];
  const currentMeta = new Map<string, PatchMeta>();
  for (const item of report.applied) currentMeta.set(item.id, item);
  for (const item of report.skipped) currentMeta.set(item.id, item);

  const prevMeta = new Map<string, PatchMeta>();
  if (baseline !== null) {
    for (const item of baseline.applied) prevMeta.set(item.id, item);
    for (const item of baseline.skipped) prevMeta.set(item.id, item);
  }

  const noticeMeta = new Map<string, PatchMeta>();
  for (const notice of carriedMergedNotices) {
    noticeMeta.set(`pr-${notice.pr}`, { parts: notice.parts, title: notice.title });
  }
  for (const notice of report.notices) {
    if (notice.kind === "merged" || notice.kind === "closed") {
      noticeMeta.set(`pr-${notice.pr}`, { parts: notice.parts, title: notice.title });
    }
  }

  const labelOf = (id: string, meta?: PatchMeta): string => meta?.title?.trim() || id;
  const merged = new Set([
    ...report.notices.filter((notice) => notice.kind === "merged").map((notice) => `pr-${notice.pr}`),
    ...carriedMergedNotices.map((notice) => `pr-${notice.pr}`),
  ]);
  const prevSkipped = new Set((baseline?.skipped ?? []).map((item) => item.id));
  const prevClosed = new Set(
    (baseline?.notices ?? [])
      .filter((notice) => notice.kind === "closed")
      .map((notice) => `pr-${notice.pr}`),
  );
  const newlyClosed = new Set(
    report.notices
      .filter((notice) => notice.kind === "closed")
      .map((notice) => `pr-${notice.pr}`)
      .filter((id) => !prevClosed.has(id)),
  );
  const handledClosed = new Set<string>();

  if (baseline !== null) {
    const prevApplied = new Map(baseline.applied.map((item) => [item.id, item] as const));
    for (const item of report.applied) {
      if (!item.parts.includes("server")) continue;
      const prev = prevApplied.get(item.id);
      const closed = newlyClosed.has(item.id);
      if (prev === undefined) {
        const base = ensurePeriod(item.summary?.trim() || "Included in this store build.");
        if (closed) {
          handledClosed.add(item.id);
          bullets.push(
            formatPatchBullet(
              `${labelOf(item.id, item)} (closed upstream)`,
              `${base} Upstream PR closed without merge, review needed.`,
            ),
          );
        } else {
          bullets.push(formatPatchBullet(labelOf(item.id, item), base));
        }
      } else if (prev.sha256 !== undefined && item.sha256 !== undefined && prev.sha256 !== item.sha256) {
        const base = ensurePeriod(item.summary?.trim() || "Updated for this nightly.");
        if (closed) {
          handledClosed.add(item.id);
          bullets.push(
            formatPatchBullet(
              `${labelOf(item.id, item)} (updated, closed upstream)`,
              `${base} Upstream PR closed without merge, review needed.`,
            ),
          );
        } else {
          bullets.push(formatPatchBullet(`${labelOf(item.id, item)} (updated)`, base));
        }
      }
    }
    const currentIds = new Set([
      ...report.applied.map((item) => item.id),
      ...report.skipped.map((item) => item.id),
    ]);
    const prevIds = [
      ...new Set([
        ...baseline.applied.map((item) => item.id),
        ...baseline.skipped.map((item) => item.id),
        ...merged,
      ]),
    ];
    for (const id of prevIds) {
      if (currentIds.has(id)) continue;
      const meta = mergeMeta(noticeMeta.get(id), prevMeta.get(id));
      if (!hasServerPart(meta.parts)) continue;
      if (merged.has(id)) {
        bullets.push(
          formatPatchBullet(
            `${labelOf(id, meta)} (merged upstream)`,
            "Included in upstream T3 Code, store patch dropped.",
          ),
        );
      } else {
        bullets.push(
          formatPatchBullet(`${labelOf(id, meta)} (dropped)`, "Removed from the store patch list."),
        );
      }
    }
  } else {
    for (const id of merged) {
      const meta = noticeMeta.get(id);
      if (!hasServerPart(meta?.parts)) continue;
      bullets.push(
        formatPatchBullet(
          `${labelOf(id, meta)} (merged upstream)`,
          "Included in upstream T3 Code, store patch dropped.",
        ),
      );
    }
  }

  for (const item of report.skipped) {
    if (!hasServerPart(item.parts)) continue;
    const closed = newlyClosed.has(item.id);
    if (prevSkipped.has(item.id) && !closed) continue;
    const detail = item.summary?.trim();
    if (closed) {
      handledClosed.add(item.id);
      bullets.push(
        formatPatchBullet(
          `${labelOf(item.id, item)} (left out, closed upstream)`,
          "Not included in this build. Upstream PR closed without merge, review needed.",
        ),
      );
    } else {
      bullets.push(
        formatPatchBullet(
          `${labelOf(item.id, item)} (left out)`,
          detail ? `Not included in this build. ${ensurePeriod(detail)}` : "Not included in this build.",
        ),
      );
    }
  }

  for (const id of newlyClosed) {
    if (handledClosed.has(id)) continue;
    const meta = mergeMeta(currentMeta.get(id), noticeMeta.get(id), prevMeta.get(id));
    if (!hasServerPart(meta.parts)) continue;
    bullets.push(
      formatPatchBullet(
        `${labelOf(id, meta)} (closed upstream)`,
        "Upstream PR closed without merge, review needed.",
      ),
    );
  }

  if (report.desktop === "failed") {
    bullets.push(
      formatPatchBullet("Store build failed", "Desktop build failed, check the release details."),
    );
  }

  return bullets;
}

function storeSummary(report: Report): string {
  const line = (applied: Applied) => `- ${applied.id} (${applied.parts.join(", ") || "docs"})`;
  return [
    `Upstream ${report.upstreamTag} plus the patches below.`,
    "",
    `Server archive: ${report.server}. Android APK: ${report.android}. Desktop AppImage: ${report.desktop}${
      report.desktopFrom === null ? "" : `, files of ${report.desktopFrom}`
    }.`,
    "",
    "Applied:",
    ...(report.applied.length > 0 ? report.applied.map(line) : ["- none"]),
    "",
    "Left out:",
    ...(report.skipped.length > 0
      ? report.skipped.map((skipped) => `- ${skipped.id}: ${skipped.reason}`)
      : ["- none"]),
    ...(report.notices.length > 0
      ? ["", "Notices:", ...report.notices.map((notice) => `- ${JSON.stringify(notice)}`)]
      : []),
    "",
    "PATCHES.json holds the same data.",
  ].join("\n");
}

function insertSummaryBullets(upstreamNotes: string, bullets: ReadonlyArray<string>): string {
  const block = bullets.join("\n");
  const detailsIdx = upstreamNotes.search(FULL_CHANGELOG_MARKER);
  const head = detailsIdx >= 0 ? upstreamNotes.slice(0, detailsIdx) : upstreamNotes;
  const tail = detailsIdx >= 0 ? upstreamNotes.slice(detailsIdx) : "";
  const plusMatch = /\n+### Plus \d+ more /m.exec(head);
  if (plusMatch !== null) {
    const before = head.slice(0, plusMatch.index);
    const sep = /(?:^|\n)[-*]\s+[^\n]*$/.test(before) ? "\n" : "\n\n";
    return `${before}${sep}${block}${head.slice(plusMatch.index)}${tail}`;
  }
  const before = head.trimEnd();
  const sep = /(?:^|\n)[-*]\s+[^\n]*$/.test(before) ? "\n" : "\n\n";
  if (detailsIdx >= 0) {
    return `${before}${sep}${block}\n\n${tail}`;
  }
  return `${before}${sep}${block}`;
}

export function releaseNotes(
  report: Report,
  options?: {
    readonly upstreamNotes?: string | undefined;
    readonly previousReport?: Report | PreviousContext | null | undefined;
  },
): string {
  const upstream = options?.upstreamNotes?.trim();
  if (!upstream) return storeSummary(report);
  const bullets = patchChangeLines(report, options?.previousReport);
  const body = bullets.length === 0 ? upstream : insertSummaryBullets(upstream, bullets);
  // T3 Desktop parses only text before `<details><summary>Full changelog</summary>`, so a second
  // collapsed block after it keeps full patch status on GitHub without polluting the update popup.
  if (FULL_CHANGELOG_MARKER.test(body)) {
    return `${body}\n\n<details>\n<summary>Store patches</summary>\n\n${storeSummary(report)}\n\n</details>`;
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// Side effects. Each uses git, gh or tar.

const run = (command: string, args: ReadonlyArray<string>, cwd?: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const tryRun = (command: string, args: ReadonlyArray<string>, cwd?: string) => {
  try {
    return { ok: true as const, out: run(command, args, cwd) };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    return { ok: false as const, out: stderr.trim().split("\n").slice(-3).join(" ") };
  }
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const LIST_FILE = "patches.json";
const loadList = (): PatchList => readJson<PatchList>(LIST_FILE);

function storeRepo(): string {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  return repo;
}

function listReleases(repo: string): ReadonlyArray<Release> {
  const out = run("gh", [
    "api",
    "--paginate",
    `repos/${repo}/releases?per_page=100`,
    "--jq",
    ".[] | {tagName: .tag_name, publishedAt: .published_at, isDraft: .draft}",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Release)
    .filter((release) => release.publishedAt !== null);
}

function listReleaseAssets(repo: string): ReadonlyArray<ReleaseAssets> {
  const out = run("gh", [
    "api",
    "--paginate",
    `repos/${repo}/releases?per_page=100`,
    "--jq",
    ".[] | select(.draft | not) | {tagName: .tag_name, assets: [.assets[].name]}",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ReleaseAssets);
}

/** The sha512 in base64 and the size of a file, as electron-builder writes them. */
function fileDigest(file: string): { readonly sha512: string; readonly size: number } {
  return { sha512: createHash("sha512").update(readFileSync(file)).digest("base64"), size: statSync(file).size };
}

function upstreamNightlies(): ReadonlyArray<Release> {
  const out = run("gh", [
    "api",
    `repos/${UPSTREAM}/releases?per_page=30`,
    "--jq",
    ".[] | {tagName: .tag_name, publishedAt: .published_at, isDraft: .draft}",
  ]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Release);
}

function prState(pr: number): PrState {
  const raw = JSON.parse(
    run("gh", ["pr", "view", String(pr), "--repo", UPSTREAM, "--json", "state,headRefOid,mergeCommit"]),
  ) as { state: PrState["state"]; headRefOid: string; mergeCommit: { oid: string } | null };
  return { state: raw.state, headRefOid: raw.headRefOid, mergeCommit: raw.mergeCommit?.oid ?? null };
}

/** True when `tag` holds `commit`. GitHub's compare reads "behind" or "identical" then. */
function tagHolds(tag: string, commit: string): boolean {
  const status = run("gh", [
    "api",
    `repos/${UPSTREAM}/compare/${tag}...${commit}`,
    "--jq",
    ".status",
  ]).trim();
  return status === "behind" || status === "identical";
}

function applyList(src: string, skip: ReadonlySet<string>): ApplyResult {
  const list = loadList();
  const applied: Applied[] = [];
  const skipped: Skipped[] = [];
  for (const entry of applyOrder(list)) {
    const id = entryId(entry);
    const patchFile = join(process.cwd(), entry.file);
    const meta = { title: entry.title.trim(), summary: entry.summary.trim() };
    if (skip.has(id) || skip.has("all")) {
      const parts = existsSync(patchFile) ? partsOf(patchPaths(readFileSync(patchFile, "utf8"))) : undefined;
      skipped.push({ id, reason: "left out by the run input", ...(parts !== undefined ? { parts } : {}), ...meta });
      continue;
    }
    const content = readFileSync(patchFile, "utf8");
    const paths = patchPaths(content);
    const parts = partsOf(paths);
    const refusal = refusalOf(paths);
    if (refusal !== undefined) {
      skipped.push({ id, reason: refusal, parts, ...meta });
      continue;
    }
    const result = tryRun("git", ["apply", "--whitespace=nowarn", patchFile], src);
    if (result.ok) {
      const sha256 = createHash("sha256").update(content).digest("hex").slice(0, 12);
      applied.push({ id, parts, sha256, ...meta });
    } else {
      skipped.push({ id, reason: `does not apply: ${result.out}`, parts, ...meta });
    }
  }
  return {
    applied,
    skipped,
    server: applied.some((item) => item.parts.includes("server")),
    mobile: applied.some((item) => item.parts.includes("mobile")),
  };
}

/** Adds PATCHES.json to the top folder of a built .tar.gz. Upstream copies are never touched. */
function addMarker(archive: string, reportFile: string) {
  const work = mkdtempSync(join(tmpdir(), "t3-marker-"));
  run("tar", ["-xzf", archive, "-C", work]);
  const top = readdirSync(work);
  if (top.length !== 1) throw new Error(`archive has ${top.length} top entries, expected 1`);
  writeFileSync(join(work, top[0]!, "PATCHES.json"), readFileSync(reportFile));
  unlinkSync(archive);
  run("tar", ["-czf", archive, "-C", work, top[0]!]);
}

function argValue(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(args: ReadonlyArray<string>, name: string): string {
  const value = argValue(args, name);
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function main(argv: ReadonlyArray<string>) {
  const [command, ...args] = argv;
  switch (command) {
    case "validate": {
      const errors = validateList(loadList());
      for (const entry of applyOrder(loadList())) {
        if (!existsSync(entry.file)) (errors as string[]).push(`${entryId(entry)}: ${entry.file} is missing`);
      }
      console.log(JSON.stringify({ ok: errors.length === 0, errors }));
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    case "plan": {
      const errors = validateList(loadList());
      if (errors.length > 0) throw new Error(errors.join("; "));
      const plan = selectTarget({
        upstream: upstreamNightlies(),
        store: listReleases(storeRepo()),
        tag: argValue(args, "--tag"),
        replace: args.includes("--replace"),
      });
      writeJson(required(args, "--out"), plan);
      console.log(JSON.stringify(plan));
      return;
    }
    case "sync": {
      const tag = required(args, "--tag");
      const list = loadList();
      const states = new Map(list.upstream.map((entry) => [entry.pr, prState(entry.pr)] as const));
      const { keep, notices } = syncEntries({
        entries: list.upstream,
        states,
        inTag: (commit) => tagHolds(tag, commit),
        tag,
        partsOfEntry: (entry) =>
          existsSync(entry.file) ? partsOf(patchPaths(readFileSync(entry.file, "utf8"))) : undefined,
      });
      for (const entry of list.upstream) {
        if (!keep.includes(entry) && existsSync(entry.file)) unlinkSync(entry.file);
      }
      writeJson(LIST_FILE, { ...list, upstream: keep });
      writeJson(required(args, "--notices"), notices);
      console.log(JSON.stringify({ notices }));
      return;
    }
    case "apply": {
      const skip = new Set(
        (argValue(args, "--skip") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== ""),
      );
      const result = applyList(required(args, "--src"), skip);
      writeJson(required(args, "--out"), result);
      console.log(JSON.stringify(result));
      return;
    }
    case "marker": {
      addMarker(required(args, "--archive"), required(args, "--report"));
      console.log(JSON.stringify({ ok: true }));
      return;
    }
    case "desktop-state": {
      console.log(desktopState(required(args, "--server") as JobResult, required(args, "--desktop") as JobResult));
      return;
    }
    case "desktop-source": {
      const from = lastDesktopRelease(listReleaseAssets(storeRepo()), required(args, "--tag")) ?? null;
      console.log(JSON.stringify({ from }));
      return;
    }
    case "desktop-check": {
      const dir = required(args, "--dir");
      const errors = [
        ...checkDesktopManifest(
          parseUpdateManifest(readFileSync(join(dir, DESKTOP_MANIFEST), "utf8")),
          required(args, "--version"),
          fileDigest(join(dir, DESKTOP_APPIMAGE)),
        ),
        ...checkAppUpdateYml(readFileSync(required(args, "--app-update"), "utf8"), storeRepo()),
      ];
      console.log(JSON.stringify({ ok: errors.length === 0, errors }));
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    case "previous-report": {
      const repo = storeRepo();
      const tag = required(args, "--tag");
      const out = required(args, "--out");
      const releases = listReleaseAssets(repo);
      const downloadReport = (releaseTag: string): Report => {
        const tmp = `${out}.tmp`;
        try {
          run("gh", ["release", "download", releaseTag, "--repo", repo, "--pattern", "PATCHES.json", "--output", tmp, "--clobber"]);
          const parsed = readJson<Report>(tmp);
          unlinkSync(tmp);
          return parsed;
        } catch (error) {
          if (existsSync(tmp)) unlinkSync(tmp);
          throw error;
        }
      };
      const hasSameTag = releases.some(
        (release) => release.tagName === tag && release.assets.includes("PATCHES.json"),
      );
      const sameTagReport = hasSameTag ? downloadReport(tag) : null;
      const candidates = previousReportTags(releases, tag);
      const visited: Report[] = [];
      let chosen: string | null = null;
      let context = selectPreviousBaseline(visited, sameTagReport);
      for (const prevTag of candidates) {
        visited.push(downloadReport(prevTag));
        context = selectPreviousBaseline(visited, sameTagReport);
        if (context.baseline !== null) {
          chosen = prevTag;
          break;
        }
      }
      if (context.baseline !== null || context.carriedMergedNotices.length > 0) {
        const tmp = `${out}.tmp`;
        try {
          writeJson(tmp, context);
          renameSync(tmp, out);
        } catch (error) {
          if (existsSync(tmp)) unlinkSync(tmp);
          throw error;
        }
      }
      console.log(JSON.stringify({ from: chosen }));
      return;
    }
    case "report": {
      const plan = readJson<Plan>(required(args, "--plan"));
      const prevReportFile = argValue(args, "--prev-report");
      let previousReport: Report | PreviousContext | null = null;
      if (prevReportFile && existsSync(prevReportFile) && statSync(prevReportFile).size > 0) {
        previousReport = readJson<Report | PreviousContext>(prevReportFile);
      }
      const notices = preserveSameTagMergedNotices(
        readJson<ReadonlyArray<Notice>>(required(args, "--notices")),
        previousReport,
        plan.tag,
      );
      const report = buildReport({
        plan,
        apply: readJson<ApplyResult>(required(args, "--apply")),
        notices,
        server: required(args, "--server") as BuildState,
        android: required(args, "--android") as BuildState,
        desktop: required(args, "--desktop") as BuildState,
        desktopFrom: argValue(args, "--desktop-from") || undefined,
      });
      const upstreamNotesFile = argValue(args, "--upstream-notes");
      const upstreamNotes =
        upstreamNotesFile && existsSync(upstreamNotesFile) ? readFileSync(upstreamNotesFile, "utf8") : undefined;
      const out = required(args, "--out");
      writeJson(join(out, "PATCHES.json"), report);
      writeFileSync(join(out, "notes.md"), `${releaseNotes(report, { upstreamNotes, previousReport })}\n`);
      console.log(JSON.stringify(report));
      return;
    }
    case "prune": {
      const repo = storeRepo();
      const keepDays = Number(argValue(args, "--keep-days") ?? loadList().keepDays);
      const tags = releasesToPrune(listReleases(repo), new Date(), keepDays);
      for (const tag of tags) run("gh", ["release", "delete", tag, "--repo", repo, "--yes", "--cleanup-tag"]);
      console.log(JSON.stringify({ deleted: tags }));
      return;
    }
    default:
      throw new Error(`unknown command ${command ?? "(none)"}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
