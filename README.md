# dsh-commit-listener

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: `/commit-listen`
watches the session workspace's git worktree and hands every new commit to the agent as a
formal new turn (`agent.followup()` → next-turn inbox → append-only session log).
Worktree-aware by default: `--all` watches every registered worktree,
`--worktree=<name|path>` binds to one.

## Files

```
package.json               dual-face manifest (dsh.client → lib/client.js)
lib/index.js               host plugin: /commit-listen + worktree fetch route
lib/client.js              browser half: composer worktree picker
test-commit-listener.mjs   self-check against a real temp git repo (node test-commit-listener.mjs)
cordis.patch.yml           the patch-list overlay that loads the plugin
```

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
/commit-listen --worktree                     # list available worktrees
/commit-listen --worktree=/                   # typing-time picker: menu completes a worktree name
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
  silently); `--worktree=<name|path>` binds to exactly one. A bare or empty
  `--worktree` is a read-only discovery query: it lists every registered
  worktree (branch, short HEAD, path, session marker) as a UI-only result and
  starts nothing — an active listener survives it.
- **Typing-time picker**: the browser half registers a second source under the
  composer's `/` trigger — type `--worktree=/` in the draft and the completion
  menu lists the repository's worktrees (branch · path, session worktree
  marked); Tab/Enter inserts the name inline. Worktree data comes from the
  host's `/commit-listener/worktrees` fetch route, resolved per session.
- Stops on `/commit-listen off`, on session close (`agent/disposed`), and on plugin
  unload/HMR (`ctx.effect` disposer).
- Commands never consume model context: results render in the UI only, while
  `command/run` / `command/done` land in the session log for auditability.
