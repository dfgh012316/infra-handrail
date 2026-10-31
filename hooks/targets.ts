import type { EngineInterface } from 'claude-code'
import type { TargetName, Targets } from '../types'

// The ambient targets a command takes when it names none. Read from the
// tools' own config files where that is cheap; kubectl itself for kube, as
// KUBECONFIG may merge several files.

type Engine = EngineInterface

async function readText($: Engine, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

export function iniValue(text: string, section: string, key: string): string | undefined {
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const head = /^\[(.+)\]$/.exec(line)
    if (head) current = head[1]!
    else if (current === section) {
      const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line)
      if (kv?.[1] === key) return kv[2]!.trim()
    }
  }
  return undefined
}

// gh keeps the active account of each host as `user:` under the host.
export function ghActiveUser(hostsYaml: string, host = 'github.com'): string | undefined {
  const block = new RegExp(`^${host.replace(/\./g, '\\.')}:\\s*\\n((?:[ \\t].*\\n?)*)`, 'm').exec(hostsYaml)
  return block ? /^ {4}user:\s*(\S+)/m.exec(block[1]!)?.[1] : undefined
}

async function kube($: Engine): Promise<string | undefined> {
  try {
    const r = await $.process.run(['kubectl', 'config', 'current-context'], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

async function gcloud($: Engine, home: string): Promise<string | undefined> {
  const dir = (await $.env.get('CLOUDSDK_CONFIG')) ?? `${home}/.config/gcloud`
  const name = (await $.env.get('CLOUDSDK_ACTIVE_CONFIG_NAME')) ?? (await readText($, `${dir}/active_config`))?.trim()
  const fromEnv = await $.env.get('CLOUDSDK_CORE_PROJECT')
  const config = name ? await readText($, `${dir}/configurations/config_${name}`) : undefined
  const project = fromEnv ?? (config ? iniValue(config, 'core', 'project') : undefined)
  if (project === undefined) return undefined
  return name ? `${project} (${name})` : project
}

async function gh($: Engine, home: string): Promise<string | undefined> {
  if ((await $.env.get('GH_TOKEN')) ?? (await $.env.get('GITHUB_TOKEN'))) return 'token from env'
  const dir = (await $.env.get('GH_CONFIG_DIR')) ?? `${home}/.config/gh`
  const hosts = await readText($, `${dir}/hosts.yml`)
  return hosts ? ghActiveUser(hosts) : undefined
}

async function aws($: Engine, home: string): Promise<string | undefined> {
  const profile = await $.env.get('AWS_PROFILE')
  if (profile) return profile
  if (await $.env.get('AWS_ACCESS_KEY_ID')) return 'keys from env'
  const config = (await readText($, `${home}/.aws/config`)) ?? (await readText($, `${home}/.aws/credentials`))
  return config ? 'default' : undefined
}

// argocd keeps its config in ARGOCD_CONFIG_DIR, else the legacy ~/.argocd
// when it exists, else the XDG folder.
export async function argocdConfig($: Engine, home: string): Promise<string | undefined> {
  const dir = await $.env.get('ARGOCD_CONFIG_DIR')
  if (dir) return readText($, `${dir}/config`)
  const xdg = (await $.env.get('XDG_CONFIG_HOME')) ?? `${home}/.config`
  return (await readText($, `${home}/.argocd/config`)) ?? (await readText($, `${xdg}/argocd/config`))
}

// ARGOCD_SERVER overrides the context.
async function argocd($: Engine, home: string): Promise<string | undefined> {
  const server = await $.env.get('ARGOCD_SERVER')
  if (server) return `${server} (env)`
  const config = await argocdConfig($, home)
  return config ? /^current-context:\s*['"]?([^\s'"]+)/m.exec(config)?.[1] : undefined
}

// Only the targets asked for are read: a target left out is never looked up.
export async function readTargets($: Engine, which: readonly TargetName[]): Promise<Targets> {
  const home = (await $.env.get('HOME')) ?? ''
  const read: Record<TargetName, () => Promise<string | undefined>> = {
    kube: () => kube($),
    gcloud: () => gcloud($, home),
    gh: () => gh($, home),
    aws: () => aws($, home),
    argocd: () => argocd($, home),
  }
  const values = await Promise.all(which.map(name => read[name]()))
  return Object.fromEntries(which.map((name, i) => [name, values[i]])) as Targets
}

export function prodTargets(t: Targets | null, pattern: RegExp): string[] {
  if (t === null) return []
  return Object.values(t).filter((v): v is string => typeof v === 'string' && pattern.test(v))
}
