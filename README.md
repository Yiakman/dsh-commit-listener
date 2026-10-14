# dsh-commit-listener

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: `/commit-listen`
watches the session workspace's git worktree and hands every new commit to the agent as a
formal new turn (`agent.followup()` → next-turn inbox → append-only session log).
Worktree-aware by default: `--all` watches every registered worktree,
`--worktree=<name|path>` binds to one.

## Files

- `commit-listener.js` — the plugin (plain ESM, zero dependencies, no build step)
- `test-commit-listener.mjs` — self-check against a real temp git repo (`node test-commit-listener.mjs`)
- `cordis.patch.yml` — the patch-list overlay that loads the plugin

## Install (DSH Desktop)

Append the insert entry from `cordis.patch.yml` to the live profile's user patch layer:

```
~/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml   # macOS, desktop app
~/.dsh/profiles/<profile>/cordis.patch.yml                                        # default DSH_HOME
```

The patch layer hot-reloads on long-lived surfaces (`patchReload: "live"`); otherwise restart the app.

## Usage

```
/commit-listen                                # session worktree, default prompt
/commit-listen Focus on security risks        # session worktree, custom prompt
/commit-listen --all                          # every registered worktree
/commit-listen --worktree=feat-x              # one worktree, by name or path
/commit-listen off                            # stop watching
```

- Polls `git worktree list --porcelain` every 2.5 s — one subprocess covers every
  worktree. Bursts between polls coalesce into one turn per changed worktree
  reporting the full `base..latest` range (diffstat + truncated unified diff),
  labeled with that worktree's path and branch.
- Worktree scoping: the default watches only the worktree containing the
  **session workspace** (`agent.session.header.cwd`) — linked worktrees hold
  private HEADs, so sibling commits never fire a turn. `--all` watches every
  registered worktree (bare and unborn skipped, late arrivals baselined
  silently); `--worktree=<name|path>` binds to exactly one.
- Stops on `/commit-listen off`, on session close (`agent/disposed`), and on plugin
  unload/HMR (`ctx.effect` disposer).
- Commands never consume model context: results render in the UI only, while
  `command/run` / `command/done` land in the session log for auditability.
