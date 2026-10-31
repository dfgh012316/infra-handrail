import type { PluginOptions } from 'claude-code'
import type { TargetName } from '../types'

// The options the manifest's userConfig declares, read into what the hooks
// use. A value of the wrong kind or out of range keeps its default, which is
// the behavior before these options existed: every guard on.

// always: every time; production: only when an ambient target matches
// prodPattern; off: never.
export type Mode = 'always' | 'production' | 'off'

export const TARGET_NAMES: readonly TargetName[] = ['kube', 'gcloud', 'gh', 'aws', 'argocd']

export type Config = {
  prod: RegExp
  namedTargets: Mode
  scriptCheck: Mode
  terraformGate: boolean
  secretGuard: boolean
  allowHelmGet: boolean
  secretTools: boolean
  watchTools: boolean
  targets: readonly TargetName[]
  band: boolean
  audit: boolean
  approveAtPermissionCheck: boolean
}

export const DEFAULT_PROD = 'prod|prd|production'

function mode(value: unknown): Mode {
  return value === 'production' || value === 'off' ? value : 'always'
}

// Booleans arrive as booleans from settings, as "true"/"false" from some writers.
function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function targets(value: unknown): readonly TargetName[] {
  const given = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : undefined
  if (given === undefined) return TARGET_NAMES
  const names = given.map(v => String(v).trim())
  return TARGET_NAMES.filter(t => names.includes(t))
}

export function readConfig(options: PluginOptions): Config {
  let prod = new RegExp(DEFAULT_PROD, 'i')
  try {
    prod = new RegExp(String(options.prodPattern ?? DEFAULT_PROD), 'i')
  } catch {
    // An unreadable pattern keeps the default.
  }
  return {
    prod,
    namedTargets: mode(options.namedTargets),
    scriptCheck: mode(options.scriptCheck),
    terraformGate: flag(options.terraformGate, true),
    secretGuard: flag(options.secretGuard, true),
    allowHelmGet: flag(options.allowHelmGet, false),
    secretTools: flag(options.secretTools, true),
    watchTools: flag(options.watchTools, true),
    targets: targets(options.targets),
    band: flag(options.band, true),
    audit: flag(options.audit, true),
    approveAtPermissionCheck: flag(options.approveAtPermissionCheck, true),
  }
}
