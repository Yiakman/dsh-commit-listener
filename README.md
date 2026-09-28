# dsh-commit-listener

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: `/commit-listen`
watches the session workspace's git repository and hands every new commit to the agent as a
formal new turn (`agent.followup()` → next-turn inbox → append-only session log).

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
/commit-listen                                # default analysis prompt
/commit-listen Focus on security risks        # custom analysis prompt
/commit-listen off                            # stop watching
```

- Polls `git rev-parse HEAD` every 2.5 s; bursts between polls coalesce into one turn
  reporting the full `base..latest` range (diffstat + truncated unified diff).
- Watches the **session workspace** (`agent.session.header.cwd`), not the server cwd —
  independent chats can listen to different repositories.
- Stops on `/commit-listen off`, on session close (`agent/disposed`), and on plugin
  unload/HMR (`ctx.effect` disposer).
- Commands never consume model context: results render in the UI only, while
  `command/run` / `command/done` land in the session log for auditability.
