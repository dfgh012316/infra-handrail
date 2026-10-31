import type { EngineInterface } from 'claude-code'
import type { AuditEntry } from '../types'
import { calls, isWrite, namesTarget, scriptRuns } from './shell'
import { argocdConfig } from './targets'

// What the configure skill decides the options from: the person's tools,
// target names and habits. Names and counts leave the mod; a history line,
// a credential or a config value other than a name never does.

type Engine = EngineInterface

const CLIS = ['kubectl', 'kubecolor', 'helm', 'helmfile', 'argocd', 'terraform', 'tofu', 'terragrunt', 'gcloud', 'aws', 'gh', 'kubectx', 'kubens']
// The newest lines of each history file: enough for habits, few enough to read
// within a hook's budget.
const HISTORY_LINES = 20_000

type Usage = { runs: number; writes: number; writesNamingNoTarget: number }

async function readText($: Engine, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function lines($: Engine, argv: string[]): Promise<string[] | undefined> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout.split('\n').map(l => l.trim()).filter(Boolean) : undefined
  } catch {
    return undefined
  }
}

// The CLIs on PATH, as `command -v` finds them. The loop's exit code is its
// last lookup's, 1 when the last CLI is missing: only the output counts.
async function installedClis($: Engine): Promise<string[] | undefined> {
  try {
    const r = await $.process.run(['sh', '-c', 'for c in "$@"; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done', 'sh', ...CLIS], {
      timeoutMs: 15_000,
    })
    return r.stdout.split('\n').map(l => l.trim()).filter(c => CLIS.includes(c))
  } catch {
    return undefined
  }
}

// Section names of an AWS config or credentials file: `[profile x]` or `[x]`.
export function awsProfiles(text: string): string[] {
  return [...text.matchAll(/^\s*\[(?:profile\s+)?([^\]\s]+)\s*\]/gm)].map(m => m[1]!)
}

// The `name:` of each entry under argocd's `contexts:`.
export function argocdContexts(text: string): string[] {
  const block = /^contexts:\s*\n((?:[ \t-].*\n?)*)/m.exec(text)?.[1] ?? ''
  return [...block.matchAll(/^\s*-?\s*name:\s*['"]?([^\s'"]+)/gm)].map(m => m[1]!)
}

// One command per entry: zsh's `: <time>:<secs>;cmd`, fish's `- cmd: cmd`, bash's plain line.
export function historyCommands(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n').slice(-HISTORY_LINES)) {
    const fish = /^- cmd: (.*)$/.exec(raw)
    if (fish) out.push(fish[1]!)
    else if (!/^\s+(when|paths):/.test(raw) && raw.trim() !== '') out.push(raw.replace(/^: \d+:\d+;/, ''))
  }
  return out
}

// How often each infra CLI runs in these commands, how often it writes, and
// how many of those writes leave the target ambient; and how many run a script.
export function usage(commands: string[], home: string): { clis: Record<string, Usage>; scriptRuns: number } {
  const clis: Record<string, Usage> = {}
  let scripts = 0
  for (const command of commands) {
    try {
      for (const call of calls(command, home, home)) {
        const u = (clis[call.tool] ??= { runs: 0, writes: 0, writesNamingNoTarget: 0 })
        u.runs++
        if (isWrite(call)) {
          u.writes++
          if (!namesTarget(call)) u.writesNamingNoTarget++
        }
      }
      scripts += scriptRuns(command, home, home).length
    } catch {
      // A line the reader cannot take is left out.
    }
  }
  return { clis, scriptRuns: scripts }
}

// The audit log by outcome and by the guard that refused.
export function auditSummary(entries: readonly AuditEntry[]) {
  const outcomes: Record<string, number> = {}
  const refusedBy = { namedTargets: 0, scriptCheck: 0, terraformGate: 0, secretGuard: 0, other: 0 }
  for (const e of entries) {
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1
    if (e.outcome !== 'refused') continue
    const note = e.note ?? ''
    if (/must name its target/.test(note)) refusedBy.namedTargets++
    else if (/reviewing it|did not run it|take the ambient target/.test(note)) refusedBy.scriptCheck++
    else if (/plan|terraform|tofu|terragrunt/.test(note)) refusedBy.terraformGate++
    else if (/Secret data|print/.test(note)) refusedBy.secretGuard++
    else refusedBy.other++
  }
  return { entries: entries.length, from: entries[0]?.at, to: entries.at(-1)?.at, outcomes, refusedBy }
}

function named(names: string[] | undefined, prod: RegExp) {
  return names === undefined ? undefined : names.map(name => ({ name, production: prod.test(name) }))
}

export async function configFacts($: Engine, prod: RegExp, audit: readonly AuditEntry[]) {
  const home = (await $.env.get('HOME')) ?? ''
  const installed = await installedClis($)
  const has = (cli: string) => installed?.includes(cli) === true

  const kube = has('kubectl') ? await lines($, ['kubectl', 'config', 'get-contexts', '-o', 'name']) : undefined
  // `name<TAB>project` for each configuration.
  const gcloud = has('gcloud')
    ? (await lines($, ['gcloud', 'config', 'configurations', 'list', '--format=value(name,properties.core.project)']))?.map(l => {
        const [name, project] = l.split('\t')
        return { name: name!, project: project || undefined, production: prod.test(`${name} ${project ?? ''}`) }
      })
    : undefined
  const awsFiles = [
    (await $.env.get('AWS_CONFIG_FILE')) ?? `${home}/.aws/config`,
    (await $.env.get('AWS_SHARED_CREDENTIALS_FILE')) ?? `${home}/.aws/credentials`,
  ]
  const awsTexts = (await Promise.all(awsFiles.map(f => readText($, f)))).filter((t): t is string => t !== undefined)
  const aws = awsTexts.length > 0 ? [...new Set(awsTexts.flatMap(awsProfiles))] : undefined
  const argocdText = await argocdConfig($, home)

  const histfile = await $.env.get('HISTFILE')
  const xdgData = (await $.env.get('XDG_DATA_HOME')) ?? `${home}/.local/share`
  const historyFiles = [...new Set([histfile, `${home}/.zsh_history`, `${home}/.bash_history`, `${xdgData}/fish/fish_history`].filter((f): f is string => !!f))]
  const read: string[] = []
  const commands: string[] = []
  for (const file of historyFiles) {
    const text = await readText($, file)
    if (text === undefined) continue
    read.push(file.startsWith(home) && home ? `~${file.slice(home.length)}` : file)
    commands.push(...historyCommands(text))
  }

  return {
    note: 'Names and counts only. production: whether a name matches the current prodPattern.',
    prodPattern: prod.source,
    installed: Object.fromEntries(CLIS.map(c => [c, has(c)])),
    targets: {
      kubeContexts: named(kube, prod),
      gcloudConfigurations: gcloud,
      awsProfiles: named(aws, prod),
      argocdContexts: named(argocdText === undefined ? undefined : argocdContexts(argocdText), prod),
    },
    audit: auditSummary(audit),
    history: { files: read, commands: commands.length, ...usage(commands, home) },
  }
}
