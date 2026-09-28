# Architecture Notes — commit-listener plugin

Design rationale for `commit-listener.js`, verified against the DeepSeek Harness
sources shipped in the desktop bundle (`@deepseek-ai/*` 0.1.5-rc.2, Cordis 4.0.2).

## 1. The plugin host: a Cordis micronucleus

Every capability in DSH is a module with an `apply(ctx)` entry point. The loader
(`@deepseek-ai/cordis-plugin-loader`) normalizes ESM/default export shapes and
mounts each module as a *fiber*: a unit of work with its own disposal boundary.

- **`inject`** — an exported array of service ids (`'commands'`, `'agents'`, …).
  Cordis defers `apply` until every named service is live, so plugins never
  hand-manage boot order.
- **`ctx.effect(execute)`** — the reversibility primitive. `execute` returns a
  disposer; Cordis runs it when the fiber is revoked (plugin unload, config
  update, HMR reload). Timers, subprocesses, and subscriptions created inside
  an effect cannot outlive their owner. This plugin registers one effect that
  stops every active listener.
- **`ctx.on(name, listener)`** — event subscriptions auto-dispose with the
  fiber. Dispatch scoping (`@deepseek-ai/dsh-scope`'s `scopeTarget`) delivers
  agent-scoped events (`agent/created`, `agent/disposed`) to listeners on any
  *untagged* context, which is how a root-level plugin observes per-session
  lifecycles — the same pattern `dsh-schedule` uses.

Dispatch modes on the typed event bus (`@deepseek-ai/cordis` `Events`):

| Mode         | Awaited | Order     | Return value | Use |
|--------------|---------|-----------|--------------|-----|
| `emit`       | no      | registration | no       | pure observation |
| `parallel`   | yes     | concurrent   | no       | fan-out notification |
| `serial`     | yes     | registration | yes      | sequenced handlers |
| `waterfall`  | no      | registration | yes      | middleware/mutation chains |
| `bail`       | no      | registration | first non-null | short-circuit lookup |

## 2. Slash commands never touch the model's context

`@deepseek-ai/dsh-commands` owns a human-command registry, mounted as the
`commands` service. Registration takes one definition object:

```js
ctx.commands.register({
  name: 'commit-listen',            // /^[a-z][a-z0-9_-]*$/
  description: '…',                 // discovery metadata for the UI
  input: { hint: '<prompt> | off' },// inline ghost hint in the composer
  handler: async ({ agent, rawInput, signal }) => ({ kind: 'success'|'error', text }),
})
```

Execution (`CommandRuntime.execute`) parses the byte-zero slash line, appends
`command/run` and `command/done` lifecycle events **directly to the session
log** (log-only appends, no turn), invokes the handler, and returns the settled
result to the UI. The handler's return value renders in the interface only —
it is never sent to the LLM. Operational ergonomics cost zero prompt tokens.

## 3. Driving the agent: followup vs steer vs inject

`ReactLoopAgent` (`@deepseek-ai/dsh-agent-loop`) exposes three inbox primitives:

| Primitive  | Inbox target | Wakes driver | Admitted |
|------------|--------------|--------------|----------|
| `followup` | `next-turn`  | yes          | as a new conversational turn |
| `steer`    | `next-step`  | yes          | at the next step boundary, mid-turn |
| `inject`   | `next-step`  | no           | passively, assembled into the next step |

**A commit is a consummated fact requiring independent analysis**, so the
correct primitive is `followup()`: it queues a formal user turn that the loop
consumes when the agent reaches rest. The wake is latched
(`wakeRequested`) and re-classified after aborts (`wakingAfterAbort`), so a
followup delivered mid-turn or during teardown is never lost — it simply
becomes the next turn.

The original report's draft gated the dispatch behind `await agent.whenIdle()`.
That is unnecessary: the inbox splice is durable the instant `followup()` runs
(`agent/inbox/spliced` in the log), and the turn machinery claims the message
only at a turn boundary. The poll loop stays decoupled from agent activity.

### The message must be fully identified

`followup(input)` requires a complete message, not a content shorthand:

```js
{
  id: randomUUID(),                     // non-empty, dedup-checked
  role: 'user',                         // validated at log append
  content: [{ type: 'text', text }],    // must be an array
  source: { kind: 'commit-listener' },  // producer-owned kind (format v4)
}
```

The inbox projection rejects duplicate pending ids, and
`assertMessageEventShape` (dsh-session) validates `id`/`role`/`source.kind`/
`content` when the turn appends `user/message`. The report's draft omitted
`id` and `role` — that message would fail both gates.

**Format v4 note (DSH ≥ 0.1.7):** the generic `{kind: 'plugin', plugin: name}`
wrapper is retired (`dsh-session-format-v3-to-v4` refuses it: "format v4
message requires a producer-owned source kind"). Each producer owns its kind —
first-party plugins write `{kind: 'schedule'}`, `{kind: 'tmux-context'}`, so a
third-party plugin writes its own name: `{kind: 'commit-listener'}`. The v3
validator accepted any non-empty kind, so this shape also runs on 0.1.5
hosts. A plugin emitting the retired wrapper appends fine in memory and then
fails at persistence, poisoning the session's projection cache — the observed
"This turn failed" in the field.

## 4. The session log invariant

The session is an append-only, event-sourced log (`~/$DSH_HOME/sessions/`,
zstd-compressed JSONL v3). Every user message, tool call, assistant frame,
inbox splice, and command lifecycle is an event; the agent loop validates each
turn against the serialized projection of history, so resume, fork, and
time-travel debugging reconstruct from one documentary source of truth.

Consequences the plugin relies on:

- Appending plugin-sourced *user* turns at the tail preserves the conversation
  prefix byte-for-byte, which keeps provider-side KV/prefix caches warm —
  time-to-first-token stays flat across listener notifications.
- Nothing needs to be "remembered" across restarts: pending followups live in
  the durable inbox projection; a crashed listener's pending analysis survives.

## 5. Why polling (and why the poll interval is the debounce)

| Technique | Latency | Rest cost | Tradeoff |
|-----------|---------|-----------|----------|
| FS watcher on `.git/refs` | < 50 ms | ~0 | must handle packed-refs rewrites, HEAD switches |
| Poll `git rev-parse HEAD` | ≤ interval | 1 subprocess / 2.5 s | portable, immune to rebase churn |
| `post-commit` hook | < 10 ms | 0 | mutates the repo, not shareable |
| Remote API / `ls-remote` | 10–60 s | network | only for non-local clones |

For local workspaces, polling wins: `rev-parse` is a single object read,
survives rebases/GC/reflog churn (a transient failure just skips a tick), and
**the interval itself is the debounce window** — any number of commits landing
between ticks coalesce into one notification reporting the whole
`base..latest` range. Extra debounce timers would be code without behavior.

Diffing uses snapshot semantics (`git diff base latest`, `git log base..latest`)
rather than `hash~1`, which breaks on root commits and rewritten history. If
`base..latest` yields no commits (history rewritten / branch switched), the
notification says so and still reports the snapshot diff. Diffs truncate at
7,500 chars; the commit list caps at 25 entries.

## 6. Workspace identity and cleanup invariants

- The watched directory is `agent.session.header.cwd` — the session's own
  workspace — **not** `process.cwd()` (the server's launch directory, shared
  by every chat). Independent sessions can listen to different repositories.
- Three stop paths, all deterministic:
  1. `/commit-listen off` → per-session disposer;
  2. session close → `agent/disposed` listener stops the matching timer;
  3. plugin unload / HMR → `ctx.effect` disposer sweeps the map.
- A vanished workspace stops the listener (checked only on failed ticks, so
  the happy path costs nothing); transient git failures are skipped silently
  and retried next tick.
- Restart semantics: invoking the command again replaces the existing listener
  for that session.

## 7. Deviations from the original report

The report's architecture narrative was accurate; its reference
implementation was not. Corrections embodied here:

| Report draft | This plugin |
|---|---|
| `followup({content, source})` | full identified message (`id`, `role`, …) |
| `process.cwd()` as repo root | `agent.session.header.cwd` |
| `await agent.whenIdle()` gate | none — the inbox is the synchronizer |
| `git diff hash~1 hash` (+ fallback) | snapshot `git diff base latest` |
| listeners leak on session close | `agent/disposed` cleanup |
| separate debounce window | poll interval coalesces by construction |
| `fs.existsSync('.git')` pre-check | let `git rev-parse` speak (worktrees/submodules have a `.git` *file*) |
