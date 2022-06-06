// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ChalkInstance } from 'chalk'
import assert from 'node:assert'
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { ChildProcess, spawn, StdioNull, StdioPipe } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { inspect } from 'node:util'
import { chalk, which } from './goods.js'
import { log } from './log.js'
import { exitCodeInfo, noop, psTree, quote, substitute } from './util.js'

export type Shell = (
  pieces: TemplateStringsArray,
  ...args: any[]
) => ProcessPromise

export type Options = {
  verbose: boolean
  cwd: string
  env: NodeJS.ProcessEnv
  shell: string | boolean
  prefix: string
  quote: typeof quote
  spawn: typeof spawn
  log: typeof log
}

const storage = new AsyncLocalStorage<Options>()
const hook = createHook({
  init: syncCwd,
  before: syncCwd,
  promiseResolve: syncCwd,
  after: syncCwd,
  destroy: syncCwd,
})
hook.enable()

function syncCwd() {
  if ($.cwd != process.cwd()) {
    process.chdir($.cwd)
  }
}

function initStore(): Options {
  const context = {
    verbose: true,
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    prefix: '',
    quote,
    spawn,
    log,
  }
  storage.enterWith(context)
  if (process.env.ZX_VERBOSE) $.verbose = process.env.ZX_VERBOSE == 'true'
  try {
    $.shell = which.sync('bash')
    $.prefix = 'set -euo pipefail;'
  } catch (err) {
    // ¯\_(ツ)_/¯
  }
  return context
}

function getStore() {
  return storage.getStore() || initStore()
}

export const $ = new Proxy<Shell & Options>(
  function (pieces, ...args) {
    let from = new Error().stack!.split(/^\s*at\s/m)[2].trim()
    let resolve: Resolve, reject: Resolve
    let promise = new ProcessPromise((...args) => ([resolve, reject] = args))
    let cmd = pieces[0],
      i = 0
    while (i < args.length) {
      let s
      if (Array.isArray(args[i])) {
        s = args[i].map((x: any) => $.quote(substitute(x))).join(' ')
      } else {
        s = $.quote(substitute(args[i]))
      }
      cmd += s + pieces[++i]
    }
    promise._bind(cmd, from, resolve!, reject!, getStore())
    // Make sure all subprocesses are started, if not explicitly by await or then().
    setImmediate(() => promise._run())
    return promise
  } as Shell & Options,
  {
    set(_, key, value) {
      Reflect.set(getStore(), key, value)
      return true
    },
    get(_, key) {
      return Reflect.get(getStore(), key)
    },
  }
)

type Resolve = (out: ProcessOutput) => void
type IO = StdioPipe | StdioNull
export type Duration = number | `${number}s` | `${number}ms`

export class ProcessPromise extends Promise<ProcessOutput> {
  child?: ChildProcess
  private _command = ''
  private _from = ''
  private _resolve: Resolve = noop
  private _reject: Resolve = noop
  private _snapshot = getStore()
  private _stdio: [IO, IO, IO] = ['inherit', 'pipe', 'pipe']
  private _nothrow = false
  private _quiet = false
  private _timeout?: number
  private _timeoutSignal?: string
  private _resolved = false
  _piped = false
  _prerun = noop
  _postrun = noop

  _bind(
    cmd: string,
    from: string,
    resolve: Resolve,
    reject: Resolve,
    options: Options
  ) {
    this._command = cmd
    this._from = from
    this._resolve = resolve
    this._reject = reject
    this._snapshot = { ...options }
  }

  _run() {
    const $ = this._snapshot
    if (this.child) return // The _run() called from two places: then() and setImmediate().
    this._prerun() // In case $1.pipe($2), the $2 returned, and on $2._run() invoke $1._run().
    $.log({
      kind: 'cmd',
      cmd: this._command,
      verbose: $.verbose && !this._quiet,
    })
    this.child = spawn($.prefix + this._command, {
      cwd: $.cwd,
      shell: typeof $.shell === 'string' ? $.shell : true,
      stdio: this._stdio,
      windowsHide: true,
      env: $.env,
    })
    this.child.on('close', (code, signal) => {
      let message = `exit code: ${code}`
      if (code != 0 || signal != null) {
        message = `${stderr || '\n'}    at ${this._from}`
        message += `\n    exit code: ${code}${
          exitCodeInfo(code) ? ' (' + exitCodeInfo(code) + ')' : ''
        }`
        if (signal != null) {
          message += `\n    signal: ${signal}`
        }
      }
      let output = new ProcessOutput(
        code,
        signal,
        stdout,
        stderr,
        combined,
        message
      )
      if (code === 0 || this._nothrow) {
        this._resolve(output)
      } else {
        this._reject(output)
      }
      this._resolved = true
    })
    let stdout = '',
      stderr = '',
      combined = ''
    let onStdout = (data: any) => {
      $.log({ kind: 'stdout', data, verbose: $.verbose && !this._quiet })
      stdout += data
      combined += data
    }
    let onStderr = (data: any) => {
      $.log({ kind: 'stderr', data, verbose: $.verbose && !this._quiet })
      stderr += data
      combined += data
    }
    if (!this._piped) this.child.stdout?.on('data', onStdout) // If process is piped, don't collect or print output.
    this.child.stderr?.on('data', onStderr) // Stderr should be printed regardless of piping.
    this._postrun() // In case $1.pipe($2), after both subprocesses are running, we can pipe $1.stdout to $2.stdin.
    if (this._timeout && this._timeoutSignal) {
      const t = setTimeout(() => this.kill(this._timeoutSignal), this._timeout)
      this.finally(() => clearTimeout(t)).catch(noop)
    }
  }

  get stdin(): Writable {
    this.stdio('pipe')
    this._run()
    assert(this.child)
    if (this.child.stdin == null)
      throw new Error('The stdin of subprocess is null.')
    return this.child.stdin
  }

  get stdout(): Readable {
    this._run()
    assert(this.child)
    if (this.child.stdout == null)
      throw new Error('The stdout of subprocess is null.')
    return this.child.stdout
  }

  get stderr(): Readable {
    this._run()
    assert(this.child)
    if (this.child.stderr == null)
      throw new Error('The stderr of subprocess is null.')
    return this.child.stderr
  }

  get exitCode() {
    return this.then(
      (p) => p.exitCode,
      (p) => p.exitCode
    )
  }

  pipe(dest: Writable | ProcessPromise) {
    if (typeof dest == 'string')
      throw new Error('The pipe() method does not take strings. Forgot $?')
    if (this._resolved) {
      if (dest instanceof ProcessPromise) dest.stdin.end() // In case of piped stdin, we may want to close stdin of dest as well.
      throw new Error(
        "The pipe() method shouldn't be called after promise is already resolved!"
      )
    }
    this._piped = true
    if (dest instanceof ProcessPromise) {
      dest.stdio('pipe')
      dest._prerun = this._run.bind(this)
      dest._postrun = () => {
        if (!dest.child)
          throw new Error(
            'Access to stdin of pipe destination without creation a subprocess.'
          )
        this.stdout.pipe(dest.stdin)
      }
      return dest
    } else {
      this._postrun = () => this.stdout.pipe(dest)
      return this
    }
  }

  async kill(signal = 'SIGTERM') {
    if (!this.child)
      throw new Error('Trying to kill child process without creating one.')
    if (!this.child.pid) throw new Error('Child process pid is undefined.')
    let children = await psTree(this.child.pid)
    for (const p of children) {
      try {
        process.kill(+p.PID, signal)
      } catch (e) {}
    }
    try {
      process.kill(this.child.pid, signal)
    } catch (e) {}
  }

  stdio(stdin: IO, stdout: IO = 'pipe', stderr: IO = 'pipe') {
    this._stdio = [stdin, stdout, stderr]
    return this
  }

  nothrow() {
    this._nothrow = true
    return this
  }

  quiet() {
    this._quiet = true
    return this
  }

  timeout(d: Duration, signal = 'SIGTERM') {
    if (typeof d == 'number') {
      this._timeout = d
    } else if (/\d+s/.test(d)) {
      this._timeout = +d.slice(0, -1) * 1000
    } else if (/\d+ms/.test(d)) {
      this._timeout = +d.slice(0, -2)
    } else {
      throw new Error(`Unknown timeout duration: "${d}".`)
    }
    this._timeoutSignal = signal
    return this
  }
}

export class ProcessOutput extends Error {
  private readonly _code: number | null
  private readonly _signal: NodeJS.Signals | null
  private readonly _stdout: string
  private readonly _stderr: string
  private readonly _combined: string

  constructor(
    code: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
    combined: string,
    message: string
  ) {
    super(message)
    this._code = code
    this._signal = signal
    this._stdout = stdout
    this._stderr = stderr
    this._combined = combined
  }

  toString() {
    return this._combined
  }

  get stdout() {
    return this._stdout
  }

  get stderr() {
    return this._stderr
  }

  get exitCode() {
    return this._code
  }

  get signal() {
    return this._signal
  }

  [inspect.custom]() {
    let stringify = (s: string, c: ChalkInstance) =>
      s.length === 0 ? "''" : c(inspect(s))
    return `ProcessOutput {
  stdout: ${stringify(this.stdout, chalk.green)},
  stderr: ${stringify(this.stderr, chalk.red)},
  signal: ${inspect(this.signal)},
  exitCode: ${(this.exitCode === 0 ? chalk.green : chalk.red)(this.exitCode)}${
      exitCodeInfo(this.exitCode)
        ? chalk.grey(' (' + exitCodeInfo(this.exitCode) + ')')
        : ''
    }
}`
  }
}

export function within<R>(callback: () => R): R {
  const result = storage.run({ ...getStore() }, callback)
  if ($.cwd != process.cwd()) {
    process.chdir($.cwd)
  }
  return result
}
