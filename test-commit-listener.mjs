// Self-check for commit-listener.js: runs the real plugin against a real git
// repo with a mock agent/context, at real poll intervals. Exit 0 = pass.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const { apply, POLL_MS, parseWorktrees } = await import('./commit-listener.js')

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
  return {
    commands: { register: (definition) => (registered.push(definition), () => {}) },
    effect: (execute) => {
      const dispose = execute()
      return () => dispose?.()
    },
    on: (event, callback) => (listeners.push({ event, callback }), () => {}),
    registered,
    listeners,
  }
}

function mockAgent(cwd) {
  const followups = []
  return {
    id: 'test-session',
    session: { header: { cwd } },
    followup: (message) => followups.push(message),
    followups,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

// --- worktrees: default scope ignores a linked worktree ----------------------
const featDir = join(root, 'feat-x')
await git(repo, 'worktree', 'add', '-q', '-b', 'feature-x', featDir)

result = await invoke('') // fresh listener, default: current worktree only
assert.equal(result.kind, 'success')
assert.match(result.text, /\(current\)/)
assert.match(result.text, /main/)

await commitFile(featDir, 'w1.txt', 'w1\n', 'feat: worktree commit 1')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 3, 'linked-worktree commit is invisible by default')

await commitFile(repo, 'm1.txt', 'm1\n', 'main commit 1')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 4)
const mainText = agent.followups[3].content[0].text
assert.match(mainText, /main commit 1/)
assert.match(mainText, /on main/)
assert.match(mainText, /Worktree: .*\/repo\n/, 'notification carries the worktree path')

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

// --- discovery: bare or empty --worktree lists worktrees, starts nothing ------
for (const flag of ['--worktree', '--worktree=']) {
  result = await invoke(flag)
  assert.equal(result.kind, 'error', `${flag} settles without starting a listener`)
  assert.match(result.text, /No worktree selected\./)
  assert.match(result.text, /Available worktrees \(--worktree=<name\|path>\):/)
  assert.match(result.text, /main\s+[0-9a-f]{7}\s+\S*\/repo\s+\(session worktree\)/)
  assert.match(result.text, /feature-x\s+[0-9a-f]{7}\s+\S+feat-x$/m)
}

// --- discovery is read-only: an active listener survives it -------------------
result = await invoke('') // default listener active again
assert.equal(result.kind, 'success')
result = await invoke('--worktree')
assert.equal(result.kind, 'error')
await commitFile(repo, 'm4.txt', 'm4\n', 'main commit 4')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 8, 'listener survived the discovery query')

await commitFile(featDir, 'w4.txt', 'w4\n', 'feat: worktree commit 4')
await sleep(POLL_MS + 1500)
assert.equal(agent.followups.length, 8, 'discovery neither replaced nor widened the listener')

rmSync(root, { recursive: true, force: true })
console.log('commit-listener self-check: all assertions passed')
