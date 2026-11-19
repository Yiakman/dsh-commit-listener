# dsh-commit-listener

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: `/commit-listen`
watches the session workspace's git worktree and hands every new commit to the agent as a
formal new turn (`agent.followup()` → next-turn inbox → append-only session log).
Worktree-aware by default: `--all` watches every registered worktree,
`--worktree=<name|path>` binds to one, and a bare run in a multi-worktree repo
**asks which one** through a clickable picker above the composer.

## Files

```
package.json               dual-face manifest (dsh.client → lib/client.js)
lib/index.js               host plugin: /commit-listen + worktree/pick fetch routes
lib/client.js              browser half: composer worktree picker + pick panel
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
/commit-listen                                # multi-worktree repo: pick (click above the composer)
/commit-listen Focus on security risks        # …with your instruction, kept for the pick
/commit-listen --all                          # every registered worktree
/commit-listen --worktree                     # list available worktrees
/commit-listen --worktree=/                   # typing-time picker: menu completes a worktree name
/commit-listen --worktree=feat-x              # one worktree, by name or path
/commit-listen --set-prompt Focus on risks    # save the default analysis instruction (2.b)
/commit-listen --set-prompt                   # clear it back to the built-in prompt
/commit-listen --set-picker=off               # deactivate the picker (2.a): watch session worktree
/commit-listen --config                       # show current settings
/commit-listen off                            # stop watching
```

- Polls `git worktree list --porcelain` every 2.5 s — one subprocess covers every
  worktree. Bursts between polls coalesce into one turn per changed worktree
  reporting the full `base..latest` range (diffstat + truncated unified diff),
  labeled with that worktree's path and branch.
- **Interactive picker (feat 1)**: when the repository has more than one
  watchable (non-bare, with commits) worktree and no scope flag is given, the
  command does not start anything — the browser half renders one full-width
  panel above the composer (`conversation.input.dock`) with a button per
  worktree (the session's tagged) plus an **All worktrees** button. A click
  POSTs to the host's pick route and starts the listener with the invocation's
  prompt; **×** dismisses. On the TUI (or wherever the panel cannot load) the
  command result carries the plain discovery listing instead.
- **Settings (2.a/2.b)**: `--set-prompt <text>` stores a global default
  instruction (inline text at invocation still wins over it, and it wins over
  the built-in prompt); `--set-picker=off` deactivates the picker so a bare run
  watches the session worktree without asking. Both persist in the plugin's own
  config through the profile config editor (survives restarts, editable in the
  patch yml as `config: { prompt: …, picker: … }`); saving reloads the plugin,
  which stops active listeners — re-run `/commit-listen` after changing.
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
- **Live ghost hint**: when the session workspace has more than one worktree,
  the composer hint re-registers with the real names — `--worktree=<repo|feat-x>`
  — so they are visible (and copyable) while typing; refreshed on session open
  and every 10 s. A single worktree keeps the generic form.
- Stops on `/commit-listen off`, on session close (`agent/disposed`), and on plugin
  unload/HMR (`ctx.effect` disposer).
- Commands never consume model context: results render in the UI only, while
  `command/run` / `command/done` land in the session log for auditability.
