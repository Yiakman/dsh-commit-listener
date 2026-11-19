// Self-check for the commit-listener plugin: runs the real plugin against a
// real git repo with a mock agent/context, at real poll intervals. Exit 0 = pass.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const { apply, POLL_MS, DEFAULT_PROMPT, parseWorktrees, hintFor } = await import('./lib/index.js')

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const IDENTITY = ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com']

async function git(cwd, ...args) {
  await exec('git', [...IDENTITY, ...args], { cwd, env: GIT_ENV })
}

function commitFile(cwd, name, content, message) {
  writeFileSync(join(cwd, name), content)
  return git(cwd, 'add', '-A').then(() => git(cwd, 'commit', '-q', '-m', message))
}

function mockContext() {
  const registered = []
  const listeners = []
  const routes = []
  const disposers = []
  const ctx = {
    commands: { register: (definition) => (registered.push(definition), () => {}) },
    connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
    effect: (execute) => {
      const dispose = execute()
      // Cordis runs every effect disposer on fiber dispose; keeping them lets
      // the restore tests simulate the settings-save reload exactly.
      disposers.push(dispose)
      return () => dispose?.()
    },
    on: (event, callback) => (listeners.push({ event, callback }), () => {}),
    // Nested soft dependency: cordis starts the callback once the service is
    // there and never otherwise; the mock mirrors exactly that.
    inject: (deps, callback) => (deps.every((dep) => ctx[dep]) ? callback(ctx) : undefined),
    registered,
    listeners,
    routes,
    disposers,
  }
  return ctx
}

function mockAgent(cwd, id = 'test-session') {
  const followups = []
  return {
    id,
    session: { header: { cwd } },
    followup: (message) => followups.push(message),
    followups,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- hintFor: ghost hint carries real worktree names --------------------------
{
  const GENERIC = '[--all | --worktree[=<name|path>]] <prompt> | --set-prompt <text> | --set-picker=on|off | --status | off'
  assert.ok(GENERIC.length <= 150, 'generic hint stays within the composer budget')
  assert.ok(GENERIC.includes('--status'), 'generic hint mentions --status')
  assert.equal(hintFor(['repo']), GENERIC, 'single worktree keeps the generic hint')
  assert.equal(
    hintFor(['repo', 'feat-x']),
    '[--all | --worktree=<repo|feat-x>] <prompt> | --set-prompt <text> | --set-picker=on|off | --status | off',
  )
  assert.ok(!hintFor(['has space', 'b', 'c']).includes('has space'), 'space-containing names are skipped')
  const long = hintFor(Array.from({ length: 8 }, (_, i) => `worktree-number-${i}-with-a-long-name`))
  assert.ok(long.length <= 150 && long.includes('…'), 'long lists truncate with an ellipsis')
  assert.ok(long.includes('--status'), 'dynamic hint keeps --status while truncating names')
}

// --- parseWorktrees: porcelain fixture (spaces, detached, bare, unborn) ------
{
  const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const ZEROS = '0'.repeat(40)
  const parsed = parseWorktrees(
    [
      'worktree /repo/main',
      `HEAD ${HEAD}`,
      'branch refs/heads/main',
      '',
      'worktree /repo/with space',
      `HEAD ${HEAD}`,
      'detached',
      '',
      'worktree /repo/bare.git',
      'bare',
      '',
      'worktree /repo/empty',
      `HEAD ${ZEROS}`,
      'branch refs/heads/main',
      '',
    ].join('\n')
  )
  assert.equal(parsed.length, 4)
  assert.deepEqual(parsed[0], { path: '/repo/main', head: HEAD, branch: 'main', bare: false })
  assert.deepEqual(parsed[1], { path: '/repo/with space', head: HEAD, branch: '(detached)', bare: false })
  assert.deepEqual(parsed[2], { path: '/repo/bare.git', head: '', branch: '(detached)', bare: true })
  assert.deepEqual(parsed[3], { path: '/repo/empty', head: ZEROS, branch: 'main', bare: false })
}

// --- setup: temp repo with one initial commit --------------------------------
const root = mkdtempSync(join(tmpdir(), 'commit-listener-test-'))
const repo = join(root, 'repo')
mkdirSync(repo)
await git(repo, 'init', '-q', '-b', 'main')
await commitFile(repo, 'README.md', 'hello\n', 'initial commit')

const ctx = mockContext()
apply(ctx)
const command = ctx.registered[0]

// --- TUI shape: no Connection service → command registers, routes do not ----
const tui = mockContext()
delete tui.connection
apply(tui)
assert.equal(tui.registered[0].name, 'commit-listen')
assert.equal(tui.routes.length, 0)

// --- definition shape (mirrors dsh-commands normalizeDefinition rules) -------
assert.equal(command.name, 'commit-listen')
assert.match(command.name, /^[a-z][a-z0-9_-]*$/u)
assert.ok(command.description.trim().length > 0)
assert.equal(typeof command.input.hint, 'string')
assert.equal(typeof command.handler, 'function')
assert.ok(ctx.listeners.some(({ event }) => event === 'agent/disposed'), 'agent/disposed cleanup registered')

// --- 'off' without an active listener errors ---------------------------------
const agent = mockAgent(repo)
const invoke = (rawInput) => command.handler({ agent, rawInput })
let result = await invoke('off')
assert.equal(result.kind, 'error')

// --- non-git directory errors ------------------------------------------------
const plain = join(root, 'plain')
mkdirSync(plain)
const plainAgent = mockAgent(plain)
result = await command.handler({ agent: plainAgent, rawInput: '' })
assert.equal(result.kind, 'error')
assert.match(result.text, /Cannot read git repo/)

// --- start: success text carries branch + short hash -------------------------
result = await invoke('')
assert.equal(result.kind, 'success')
assert.match(result.text, /main/)
assert.match(result.text, /[0-9a-f]{7}/)

// --- burst coalescing: two quick commits → ONE turn listing both -------------
await sleep(300) // let the start baseline settle
await commitFile(repo, 'a.txt', 'a\n', 'add a.txt')
await commitFile(repo, 'b.txt', 'b\n', 'add b.txt')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 1, 'burst coalesces into one followup')

const message = agent.followups[0]
assert.equal(message.role, 'user')
assert.ok(typeof message.id === 'string' && message.id !== '', 'message has a non-empty id')
assert.deepEqual(message.source, { kind: 'commit-listener' })
assert.equal(message.content.length, 1)
assert.equal(message.content[0].type, 'text')
const text = message.content[0].text
assert.match(text, /2 new commits on main/)
assert.match(text, /add a\.txt/)
assert.match(text, /add b\.txt/)
assert.match(text, /```diff/)
assert.match(text, /Instruction: /, 'default analysis prompt present')

// --- big commit: diff truncated ----------------------------------------------
writeFileSync(join(repo, 'big.txt'), 'x'.repeat(200_000) + '\n')
await git(repo, 'add', '-A')
await git(repo, 'commit', '-q', '-m', 'add big file')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 2, 'second followup arrives')
const bigText = agent.followups[1].content[0].text
assert.match(bigText, /1 new commit on main/)
assert.match(bigText, /\[\.\.\. diff truncated \.\.\.\]/)
assert.ok(bigText.length < 20_000, 'notification stays small')

// --- custom prompt is used ----------------------------------------------------
result = await invoke('Rate the risk of these changes from 0 to 10.')
assert.equal(result.kind, 'success')
await commitFile(repo, 'c.txt', 'c\n', 'add c.txt')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 3)
assert.match(agent.followups[2].content[0].text, /Rate the risk of these changes from 0 to 10\./)

// --- agent disposal stops the listener ----------------------------------------
const disposed = ctx.listeners.find(({ event }) => event === 'agent/disposed')
disposed.callback({ agent })
await commitFile(repo, 'd.txt', 'd\n', 'add d.txt')
await sleep(POLL_MS + 1000)
assert.equal(agent.followups.length, 3, 'no followup after agent/disposed cleanup')

// --- 'off' stops the listener -------------------------------------------------
result = await invoke('') // fresh listener with default prompt
assert.equal(result.kind, 'success')
result = await invoke('off')
assert.equal(result.kind, 'success')
await commitFile(repo, 'e.txt', 'e\n', 'add e.txt')
await sleep(POLL_MS + 1000)
assert.equal(agent.followups.length, 3, 'no followup after off')
result = await invoke('off')
assert.equal(result.kind, 'error', 'off again errors: nothing active')

// --- settings flags: query works without a config editor; saves need one -----
result = await invoke('--config')
assert.equal(result.kind, 'success')
assert.match(result.text, /picker: on/)
assert.match(result.text, /built-in analysis prompt/)
result = await invoke('--set-prompt Focus on security')
assert.equal(result.kind, 'error', 'mock context has no config editor service')
assert.match(result.text, /cannot be saved/i)
result = await invoke('--set-picker=maybe')
assert.equal(result.kind, 'error')
assert.match(result.text, /accepts "on" or "off"/)

// --- --status with nothing active: idle report + settings ----------------------
result = await invoke('--status')
assert.equal(result.kind, 'success')
assert.match(result.text, /No commit listener is active for this session\./)
assert.match(result.text, /Start one with \/commit-listen/)
assert.match(result.text, /picker: on/, 'persisted settings ride along')
assert.match(result.text, /built-in analysis prompt/)

// --- settings saves through a mocked config editor: quoting and clear --------
{
  const saved = []
  const settingsCtx = mockContext()
  settingsCtx.fiber = { entry: { id: 'commit-listener' } }
  settingsCtx.get = (name) =>
    name === 'configEditor'
      ? { edit: async (entry, change) => void saved.push(change({})) }
      : undefined
  apply(settingsCtx)
  const settingsCommand = settingsCtx.registered[0]
  const settingsAgent = mockAgent(repo)
  const run = (rawInput) => settingsCommand.handler({ agent: settingsAgent, rawInput })

  // bare form: rest of the line is the value
  await run('--set-prompt Review each following commit.')
  // bare form: one wrapping pair of quotes is stripped
  await run('--set-prompt "Review each following commit."')
  // =value form with a quoted value spanning words (the shell-style spelling)
  await run('--set-prompt="Review each following commit. Identify the commit in the title with its hash."')
  // =value form, single token
  await run('--set-prompt=Shorthand')
  // quoted value with an embedded single quote (typographic apostrophe)
  await run(`--set-prompt="Don’t change the code."`)
  // empty value clears
  await run('--set-prompt')
  await run('--set-picker=off')
  await run('--set-picker=on')

  const prompts = saved.map((config) => config.prompt)
  assert.deepEqual(
    prompts.slice(0, 5),
    [
      'Review each following commit.',
      'Review each following commit.',
      'Review each following commit. Identify the commit in the title with its hash.',
      'Shorthand',
      'Don’t change the code.',
    ],
    'every --set-prompt spelling saves the full text with quotes stripped',
  )
  assert.equal(prompts[5], undefined, 'bare --set-prompt clears the default')
  assert.deepEqual(saved[6].picker, false, '--set-picker=off stored')
  assert.deepEqual(saved[7].picker, true, '--set-picker=on stored')

  const savedResult = await run('--set-prompt="Review each commit."')
  assert.equal(savedResult.kind, 'success')
  assert.match(savedResult.text, /Settings saved/)
  assert.match(savedResult.text, /"Review each commit\."/)
}

// --- worktrees: linked worktree joins the repo -------------------------------
const featDir = join(root, 'feat-x')
await git(repo, 'worktree', 'add', '-q', '-b', 'feature-x', featDir)

// ghost hint: a known session with 2+ worktrees re-registers with real names
ctx.listeners.find(({ event }) => event === 'agent/created').callback({ agent })
await sleep(400)
assert.ok(ctx.registered.length >= 2, 'hint refresh re-registered the command')
const hinted = ctx.registered[ctx.registered.length - 1]
assert.match(hinted.input.hint, /--worktree=<repo\|feat-x>/, 'hint lists the real worktree names')
ctx.listeners.find(({ event }) => event === 'agent/created').callback({ agent })
await sleep(400)
assert.equal(ctx.registered.length, 2, 'unchanged worktree set does not re-register')

// --- interactive picker: bare invocation in a multi-worktree repo asks --------
const pickRoute = ctx.routes.find((entry) => entry.path === '/api/commit-listener/pick')
assert.ok(pickRoute, 'pick fetch route registered')

result = await invoke('')
assert.equal(result.kind, 'error', 'bare invocation asks instead of silently starting')
assert.match(result.text, /Multiple worktrees/)
assert.match(result.text, /Available worktrees \(--worktree=<name\|path>\):/)

let pickResponse = await pickRoute.fetch(new Request('http://localhost/api/commit-listener/pick?session=test-session'))
assert.equal(pickResponse.status, 200)
let pickData = await pickResponse.json()
assert.equal(pickData.pending.worktrees.length, 2, 'only watchable worktrees offered')
assert.ok(pickData.pending.worktrees.every((wt) => wt.name === 'repo' || wt.name === 'feat-x'))
assert.equal(pickData.pending.worktrees.find((wt) => wt.name === 'repo').session, true, 'session worktree flagged')
assert.equal(pickData.pending.worktrees.find((wt) => wt.name === 'feat-x').session, false)
assert.equal(pickData.listening, null, 'listening is null before anything started')

pickResponse = await pickRoute.fetch(
  new Request('http://localhost/api/commit-listener/pick?session=test-session', {
    method: 'POST',
    body: JSON.stringify({ target: 'feat-x' }),
  }),
)
assert.equal(pickResponse.status, 200)
const startResult = await pickResponse.json()
assert.equal(startResult.kind, 'success', 'picking starts the listener')
assert.match(startResult.text, /\(worktree\)/)
assert.match(startResult.text, /feature-x/)

pickResponse = await pickRoute.fetch(new Request('http://localhost/api/commit-listener/pick?session=test-session'))
pickData = await pickResponse.json()
assert.equal(pickData.pending, null, 'no pending state left after the pick')
// the same poll carries the live listener state for the composer chip
assert.ok(pickData.listening, 'listening rides the pick poll once a listener runs')
assert.equal(pickData.listening.mode, 'worktree')
assert.equal(pickData.listening.target, 'feat-x')
assert.equal(pickData.listening.prompt, DEFAULT_PROMPT, 'pick-started listener kept the parked prompt')
assert.equal(pickData.listening.entries.length, 1)
assert.equal(pickData.listening.entries[0].name, 'feat-x')
assert.equal(pickData.listening.entries[0].branch, 'feature-x')
assert.match(pickData.listening.entries[0].head, /^[0-9a-f]{7}$/, 'short HEAD, same shape as serializeWorktrees')

// the route-started listener fires on the picked worktree only
await commitFile(featDir, 'w1.txt', 'w1\n', 'feat: worktree commit 1')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 4)
assert.match(agent.followups[3].content[0].text, /feat: worktree commit 1/)
assert.match(agent.followups[3].content[0].text, /on feature-x/)

await commitFile(repo, 'm1.txt', 'm1\n', 'main commit 1')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 4, 'unpicked sibling stays invisible')

// --- --all: one followup per changed worktree, flags stripped from prompt ----
result = await invoke('--all Watch both worktrees')
assert.equal(result.kind, 'success')
assert.match(result.text, /\(all\)/)
assert.match(result.text, /main/)
assert.match(result.text, /feature-x/)

await commitFile(repo, 'm2.txt', 'm2\n', 'main commit 2')
await commitFile(featDir, 'w2.txt', 'w2\n', 'feat: worktree commit 2')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 6, 'one followup per changed worktree')
const allTexts = agent.followups.slice(4).map((m) => m.content[0].text)
assert.ok(allTexts.every((t) => t.includes('Instruction: Watch both worktrees')), 'flags stripped from prompt')
assert.ok(
  allTexts.some((t) => /on main/.test(t) && t.includes('main commit 2') && /Worktree: .*\/repo\n/.test(t)),
  'main-repo turn labeled with its own worktree'
)
assert.ok(
  allTexts.some((t) => /on feature-x/.test(t) && t.includes('worktree commit 2') && /Worktree: .*feat-x\n/.test(t)),
  'linked-worktree turn labeled with its own worktree'
)

// --- --worktree=<name>: binds to a sibling worktree from the main repo -------
result = await invoke('--worktree=feat-x')
assert.equal(result.kind, 'success')
assert.match(result.text, /\(worktree\)/)
assert.match(result.text, /feature-x/)

await commitFile(repo, 'm3.txt', 'm3\n', 'main commit 3') // unwatched sibling
await commitFile(featDir, 'w3.txt', 'w3\n', 'feat: worktree commit 3')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 7, 'only the bound worktree notifies')
assert.match(agent.followups[6].content[0].text, /worktree commit 3/)
assert.match(agent.followups[6].content[0].text, /on feature-x/)

// --- --worktree=<path>: the exact porcelain-reported path also resolves ------
const listed = parseWorktrees(
  (await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repo, env: GIT_ENV })).stdout
)
const feat = listed.find((wt) => wt.branch === 'feature-x')
result = await invoke(`--worktree=${feat.path}`)
assert.equal(result.kind, 'success')
assert.match(result.text, /feature-x/)

// --- --worktree=<unknown>: error carries the discovery listing ---------------
result = await invoke('--worktree=nope')
assert.equal(result.kind, 'error')
assert.match(result.text, /No worktree matches "nope"/)
assert.match(result.text, /Available worktrees \(--worktree=<name\|path>\):/)
assert.match(result.text, /feat-x/)

// --- discovery is read-only: an active listener survives it -------------------
result = await invoke('--worktree=repo') // explicit flag: no picker prompt
assert.equal(result.kind, 'success')

// --- --status while listening: mode, watched worktrees, baseline, prompt ------
result = await invoke('--status')
assert.equal(result.kind, 'success')
assert.match(result.text, /Commit listener active for this session/)
assert.match(result.text, /mode: worktree — target: repo/)
assert.match(result.text, /\[main\] repo @ [0-9a-f]{7}\n/, 'watched line: branch, basename, short baseline HEAD')
assert.match(result.text, /prompt: ".*" \(built-in\)/)

result = await invoke('--worktree')
assert.equal(result.kind, 'error')
await commitFile(repo, 'm4.txt', 'm4\n', 'main commit 4')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 8, 'listener survived the discovery query')

await commitFile(featDir, 'w4.txt', 'w4\n', 'feat: worktree commit 4')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 8, 'discovery neither replaced nor widened the listener')

// --- dismiss: the × clears a pending pick without starting anything ----------
result = await invoke('')
assert.equal(result.kind, 'error')
pickResponse = await pickRoute.fetch(new Request('http://localhost/api/commit-listener/pick?session=test-session'))
assert.notEqual((await pickResponse.json()).pending, null, 'pending state exists while deciding')

// --- --status while a pick is pending -------------------------------------------
result = await invoke('--status')
assert.equal(result.kind, 'success')
assert.match(result.text, /waiting for worktree selection/i, 'pending pick is called out')
assert.match(result.text, /2 worktrees offered/)

pickResponse = await pickRoute.fetch(
  new Request('http://localhost/api/commit-listener/pick?session=test-session', { method: 'POST', body: '{}' }),
)
assert.equal((await pickResponse.json()).text, 'Selection dismissed; nothing started.')

// 'off' clears a pending pick too
result = await invoke('')
assert.equal(result.kind, 'error')
result = await invoke('off')
assert.equal(result.kind, 'success')
pickResponse = await pickRoute.fetch(new Request('http://localhost/api/commit-listener/pick?session=test-session'))
assert.equal((await pickResponse.json()).pending, null)

// --- stop sentinel: POST __stop__ stops the listener, pending pick or not -----
result = await invoke('--worktree=repo')
assert.equal(result.kind, 'success')
pickResponse = await pickRoute.fetch(
  new Request('http://localhost/api/commit-listener/pick?session=test-session', {
    method: 'POST',
    body: JSON.stringify({ target: '__stop__' }),
  }),
)
assert.equal(pickResponse.status, 200)
assert.deepEqual(await pickResponse.json(), { kind: 'success', text: 'Commit listener stopped.' })
await commitFile(repo, 'm5.txt', 'm5\n', 'main commit 5')
await sleep(POLL_MS + 1000)
assert.equal(agent.followups.length, 8, 'listener stopped by the sentinel: no followup')
// nothing was pending above, and a second stop is a no-op success
pickResponse = await pickRoute.fetch(
  new Request('http://localhost/api/commit-listener/pick?session=test-session', {
    method: 'POST',
    body: JSON.stringify({ target: '__stop__' }),
  }),
)
assert.equal((await pickResponse.json()).kind, 'success')
// the chip's poll reflects the stop…
pickResponse = await pickRoute.fetch(new Request('http://localhost/api/commit-listener/pick?session=test-session'))
assert.equal((await pickResponse.json()).listening, null)
// …and an unknown session errors instead of reporting a phantom stop
pickResponse = await pickRoute.fetch(
  new Request('http://localhost/api/commit-listener/pick?session=unknown-session', {
    method: 'POST',
    body: JSON.stringify({ target: '__stop__' }),
  }),
)
assert.equal(pickResponse.status, 400)

// --- setting picker:false — bare invocation proceeds with the session worktree
const quietCtx = mockContext()
apply(quietCtx, { picker: false })
const quietCommand = quietCtx.registered[0]
const quietAgent = mockAgent(repo)
result = await quietCommand.handler({ agent: quietAgent, rawInput: '' })
assert.equal(result.kind, 'success', 'no prompt when the picker is deactivated')
assert.match(result.text, /\(current\)/)
result = await quietCommand.handler({ agent: quietAgent, rawInput: '--config' })
assert.equal(result.kind, 'success')
assert.match(result.text, /picker: off/)
assert.match(result.text, /watches the session worktree without asking/)

// --- configured default prompt: used when the invocation passes no text ------
const cfgCtx = mockContext()
apply(cfgCtx, { prompt: 'Custom default analysis.' })
const cfgCommand = cfgCtx.registered[0]
const cfgAgent = mockAgent(repo)
result = await cfgCommand.handler({ agent: cfgAgent, rawInput: '--worktree=feat-x' })
assert.equal(result.kind, 'success')
await commitFile(featDir, 'p1.txt', 'p1\n', 'feat: configured default prompt')
await sleep(POLL_MS + 1500)
assert.equal(cfgAgent.followups.length, 1)
assert.match(cfgAgent.followups[0].content[0].text, /Instruction: Custom default analysis\./)

// ...and inline text still wins over the configured default
result = await cfgCommand.handler({ agent: cfgAgent, rawInput: '--worktree=feat-x Inline instruction wins' })
assert.equal(result.kind, 'success')
await commitFile(featDir, 'p2.txt', 'p2\n', 'feat: inline prompt wins')
await sleep(POLL_MS + 1500)
assert.equal(cfgAgent.followups.length, 2)
assert.match(cfgAgent.followups[1].content[0].text, /Instruction: Inline instruction wins/)

// --- browser picker route: /api/commit-listener/worktrees ------------------------
const route = ctx.routes.find((entry) => entry.path === '/api/commit-listener/worktrees')
assert.ok(route, 'worktree fetch route registered')

const routeResponse = await route.fetch(new Request(`http://localhost/api/commit-listener/worktrees?cwd=${encodeURIComponent(repo)}`))
assert.equal(routeResponse.status, 200)
const routeData = await routeResponse.json()
assert.equal(routeData.worktrees.length, 2)
const mainRow = routeData.worktrees.find((wt) => wt.name === 'repo')
assert.equal(mainRow.branch, 'main')
assert.equal(mainRow.session, true, 'session worktree tagged for the picker')
assert.deepEqual(mainRow.markers, [])
const featRow = routeData.worktrees.find((wt) => wt.name === 'feat-x')
assert.equal(featRow.branch, 'feature-x')
assert.equal(featRow.session, false)

// non-git cwd and unknown session both settle as 400 JSON errors
assert.equal((await route.fetch(new Request(`http://localhost/api/commit-listener/worktrees?cwd=${encodeURIComponent(plain)}`))).status, 400)
assert.equal((await route.fetch(new Request('http://localhost/api/commit-listener/worktrees?session=nope'))).status, 400)

// session-scoped: the host resolves ?session= through the tracked agent map
ctx.listeners.find(({ event }) => event === 'agent/created').callback({ agent })
const sessionResponse = await route.fetch(new Request('http://localhost/api/commit-listener/worktrees?session=test-session'))
assert.equal(sessionResponse.status, 200)
assert.equal((await sessionResponse.json()).worktrees.length, 2)

// --- browser half: module shape + slot/trigger registration smoke test ------
{
  const loaded = []
  const fakeWindow = { __ModuleLoader__: { load: (handoff) => loaded.push(handoff) } }
  new Function('window', readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'))(fakeWindow)
  assert.equal(loaded.length, 1, 'one ModuleLoader handoff')
  assert.equal(loaded[0].id, 'dsh-commit-listener')

  const noop = () => () => {}
  const react = {
    createElement: (...args) => ({ args }),
    Fragment: Symbol('fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => undefined,
  }
  const clientExports = loaded[0].factory((spec) => {
    if (spec === 'react') return react
    throw new Error(`unexpected require: ${spec}`)
  })
  assert.deepEqual(clientExports.inject, ['inputTriggers'])
  assert.equal(typeof clientExports.apply, 'function')

  const registeredSources = []
  const slotInjections = []
  const slotRegistrations = []
  const clientCtx = {
    get: (name) =>
      name === 'inputTriggers' ? { registerSource: (source) => (registeredSources.push(source), noop()) } : undefined,
    effect: (execute) => {
      const dispose = execute()
      return () => dispose?.()
    },
    inject: (deps, callback) => (deps.every((dep) => clientCtx[dep]) ? callback(clientCtx) : undefined),
    slots: {
      inject: (key, callback) => {
        slotInjections.push(key)
        return callback() ?? noop()
      },
      register: (options, component) => {
        slotRegistrations.push({ options, component })
        return noop()
      },
    },
  }
  clientExports.apply(clientCtx)
  assert.equal(registeredSources[0].name, 'commit-listener-worktrees', 'typing-time source registered')
  assert.equal(registeredSources[0].trigger, '/')
  assert.deepEqual(slotInjections, ['conversation.input.dock'], 'picker panel targets the input dock')
  assert.equal(slotRegistrations[0].options.id, 'commit-listener-picker')
  assert.equal(typeof slotRegistrations[0].component, 'function')

  // Panel render smoke: nothing without a session or a pending pick. (With a
  // pending pick the hooks-based flow needs a real renderer; the host-side
  // route tests above cover the data contract it renders.)
  const Picker = slotRegistrations[0].component
  assert.equal(Picker({}), null, 'no session → nothing rendered')
  assert.equal(Picker({ session: { sessionId: 's1' } }), null, 'no pending pick → nothing rendered')
}

// --- restore: listeners re-arm across a settings-save reload -------------------
// The suite imports the real module once, so module-level state (the handoff)
// persists across apply() calls in this process — exactly like a config-only
// fiber reload in DSH, where the loader reuses the cached module instance.
{
  const repo2 = join(root, 'restore')
  mkdirSync(repo2)
  await git(repo2, 'init', '-q', '-b', 'main')
  await commitFile(repo2, 'base.txt', 'base\n', 'restore base')

  // apply #1: start a listener and report one commit through it
  const ctx1 = mockContext()
  apply(ctx1)
  const cmd1 = ctx1.registered[0]
  const agent1 = mockAgent(repo2, 'restore-session')
  result = await cmd1.handler({ agent: agent1, rawInput: '' })
  assert.equal(result.kind, 'success')
  await commitFile(repo2, 'pre.txt', 'pre\n', 'before reload')
  await sleep(POLL_MS + 1500)
  assert.equal(agent1.followups.length, 1, 'pre-reload commit reported')

  // The fiber dispose a settings save triggers: timers stop (lifecycle stop),
  // the module-level handoff survives.
  for (const dispose of ctx1.disposers) dispose()
  await commitFile(repo2, 'gap.txt', 'gap\n', 'during reload gap')
  await sleep(POLL_MS + 1500)
  assert.equal(agent1.followups.length, 1, 'disposed fiber reports nothing')

  // apply #2 (same module, same agent): re-arm resumes from the SAVED baseline
  // — the gap commit fires exactly one followup, nothing is rebaselined away
  // and nothing already reported is reported twice.
  const ctx2 = mockContext()
  apply(ctx2)
  const cmd2 = ctx2.registered[0]
  await sleep(POLL_MS + 1500)
  assert.equal(agent1.followups.length, 2, 'gap commit fires exactly one followup after restore')
  const restoredText = agent1.followups[1].content[0].text
  assert.match(restoredText, /during reload gap/)
  assert.ok(!restoredText.includes('before reload'), 'already-reported commits are not re-reported')

  // The restored listener is visible to --status, and the browser routes keep
  // resolving the existing session (agents map re-seeded from the handoff).
  result = await cmd2.handler({ agent: agent1, rawInput: '--status' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Commit listener active for this session/)
  assert.match(result.text, /mode: current/)
  const restoreRoute = ctx2.routes.find((entry) => entry.path === '/api/commit-listener/worktrees')
  assert.equal(
    (await restoreRoute.fetch(new Request('http://localhost/api/commit-listener/worktrees?session=restore-session'))).status,
    200,
    'agents map re-seeded from handoff entries',
  )

  // 'off' before a dispose prevents restore: explicit stops stay off.
  result = await cmd2.handler({ agent: agent1, rawInput: 'off' })
  assert.equal(result.kind, 'success')
  for (const dispose of ctx2.disposers) dispose()
  await commitFile(repo2, 'post.txt', 'post\n', 'after explicit off')
  const ctx3 = mockContext()
  apply(ctx3)
  await sleep(POLL_MS + 1500)
  assert.equal(agent1.followups.length, 2, 'off before dispose: nothing restores')

  // agent/disposed clears the handoff entry: a closed session never restores.
  const ctxA = mockContext()
  apply(ctxA)
  const cmdA = ctxA.registered[0]
  await cmdA.handler({ agent: agent1, rawInput: '' })
  ctxA.listeners.find(({ event }) => event === 'agent/disposed').callback({ agent: agent1 })
  for (const dispose of ctxA.disposers) dispose()
  const ctxB = mockContext()
  apply(ctxB)
  await commitFile(repo2, 'gone.txt', 'gone\n', 'session gone')
  await sleep(POLL_MS + 1500)
  assert.equal(agent1.followups.length, 2, 'agent/disposed cleared the handoff: nothing restores')
}

rmSync(root, { recursive: true, force: true })
console.log('commit-listener self-check: all assertions passed')
