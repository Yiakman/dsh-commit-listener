// Self-check for commit-listener.js: runs the real plugin against a real git
// repo with a mock agent/context, at real poll intervals. Exit 0 = pass.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const { apply, POLL_MS } = await import('./commit-listener.js')

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

rmSync(root, { recursive: true, force: true })
console.log('commit-listener self-check: all assertions passed')
