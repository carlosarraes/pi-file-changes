# pi-file-changes

A [Pi coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for reviewing file changes and safely accepting or declining Pi-made edits.

## What it does

- `/fc` shows file changes and lets you pick inline or pdiff review
- `/fc-diff` opens all current review changes in [`pdiff`](https://github.com/carlosarraes/pdiff)
- `/fc-accept` accepts Pi-tracked edits by clearing the log
- `/fc-decline` declines Pi-tracked edits by restoring original file contents
- `fc_accept` lets the agent clear the log after successful commit/push workflows
- In git repos, review uses git so it sees modified, staged, deleted, renamed, and untracked files
- Accept/decline only affects files Pi touched through `edit` or `write`

## Install

```
pi install git:github.com/carlosarraes/pi-file-changes
```

Requires `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` >= 0.49.0.

For pdiff review:

```
cargo install --git https://github.com/carlosarraes/pdiff
```

## Usage

- `/fc` — open the file changes picker
- `/fc-diff` — review all current changes in pdiff
- `/fc-accept` — keep Pi-made changes and clear the Pi tracking log
- `/fc-decline` — revert Pi-made changes to their pre-Pi baseline

## Notes

In a git repo, git is used for review only. `/fc-accept` and `/fc-decline` still use Pi's `edit`/`write` tracking, so unrelated dirty files are not reverted.

`/fc-decline` restores whole files to their pre-Pi baseline. If you make manual or formatter changes to the same file after Pi edits it, those same-file changes can be overwritten.

## License

MIT
