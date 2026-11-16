# Repair a store fault

A timer on Morgan's PC starts a chat with this file when the newest release
needs a repair, or when the newest upstream nightly has no store release one
hour after it came out. The wake message names the release and the reason.

Read the release's `PATCHES.json` and the last run of the `Nightly` workflow
first. Then act on each fault:

- A patch is left out, "does not apply". Rebase that one patch on the new
  nightly tag in a scratch copy of upstream. Keep its meaning, add no feature.
  For an upstream PR, check first if its author pushed a new head that applies,
  and move the pin to it. Run the tests of the touched package. Open a PR on
  this repo with the new patch file, then run the workflow with the tag and
  `replace` after the merge.
- A build failed. Read the failed step. Repair the workflow when upstream
  changed a build step. Never publish a release by hand.
- A PR was closed unmerged. Ask Morgan: keep it as an own patch, or drop it.
- No release for the newest nightly. The gate started the workflow 60 minutes
  ago, or the reason gives its start error. Read the run of that start and the
  last runs. Check that the workflow is on (GitHub turns off a workflow after
  60 days with no repo activity). Turn it on and run it.

Write nothing to pingdotgg/t3code. Own patches stay at most 8, bug fixes only,
each with its Shell issue, its check and a `dropWhen` line. The one feature
exception is `1448-form-free-text-mic` (Shell issue 1448). Rebase it like a
bug fix, and add no other feature.
