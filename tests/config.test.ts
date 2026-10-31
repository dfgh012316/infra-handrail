import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { readConfig, TARGET_NAMES } from '../hooks/config'
import { argocdContexts, auditSummary, awsProfiles, historyCommands, usage } from '../hooks/facts'
import type { AuditEntry } from '../types'
import { BAND, engine, exited, HOME, refused } from './helpers'

const UP = { '/w/up.sh': 'helm upgrade --install api ./charts/api\n' }

// The engine's answers beneath what session.start registers.
function registry(on: On) {
  const tools: string[] = []
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__infra-handrail__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return tools
}

describe('reading the options', () => {
  test('defaults to every guard on, as before the options existed', () => {
    const c = readConfig({})
    expect(c).toMatchObject({ namedTargets: 'always', scriptCheck: 'always', terraformGate: true, secretGuard: true, allowHelmGet: false })
    expect(c).toMatchObject({ secretTools: true, watchTools: true, band: true, audit: true, approveAtPermissionCheck: true })
    expect(c.targets).toEqual(TARGET_NAMES)
    expect(c.prod.test('eu-PROD-1')).toBe(true)
  })

  test('keeps the default for a value of the wrong kind, and reads strings a writer may store', () => {
    const c = readConfig({ namedTargets: 'sometimes', scriptCheck: 'production', terraformGate: 'false', audit: 'yes', prodPattern: '(' })
    expect(c.namedTargets).toBe('always')
    expect(c.scriptCheck).toBe('production')
    expect(c.terraformGate).toBe(false)
    expect(c.audit).toBe(true)
    expect(c.prod.source).toBe('prod|prd|production')
  })

  test('reads targets as a list or a comma-separated string, unknown names left out', () => {
    expect(readConfig({ targets: ['aws', 'kube', 'nomad'] }).targets).toEqual(['kube', 'aws'])
    expect(readConfig({ targets: 'gh, kube' }).targets).toEqual(['kube', 'gh'])
    expect(readConfig({ targets: [] }).targets).toEqual([])
  })
})

describe('named targets', () => {
  const ANNOTATE = { tool: 'Bash', command: 'kubectl annotate ns default x=1' } as const

  test('off: a change on the ambient context runs', { options: { namedTargets: 'off' } }, async ($, on) => {
    const { ran } = engine(on)
    on('process.run', () => exited(0, 'prod-eu\n'))
    expect(refused(await $.tool.call(ANNOTATE))).toBeUndefined()
    expect(ran.length).toBe(1)
  })

  test('production: refused on a production context only', { options: { namedTargets: 'production' } }, async ($, on) => {
    const { ran } = engine(on)
    let context = 'dev'
    on('process.run', () => exited(0, `${context}\n`))
    expect(refused(await $.tool.call(ANNOTATE))).toBeUndefined()
    context = 'prod-eu'
    // The targets are read again before the next check.
    await $.tool.call({ tool: 'Bash', command: 'kubectl config use-context prod-eu' })
    expect(refused(await $.tool.call(ANNOTATE))).toContain('kubectl --context')
    expect(ran.length).toBe(2)
  })
})

describe('the script check', () => {
  test('off: a script runs unread', { options: { scriptCheck: 'off' } }, async ($, on) => {
    const { ran, asked } = engine(on, { files: UP })
    on('process.run', () => exited(0, 'prod-eu\n'))
    expect(refused(await $.tool.call({ tool: 'Bash', command: './up.sh' }))).toBeUndefined()
    expect(ran).toEqual(['./up.sh'])
    expect(asked.length).toBe(0)
  })

  test('production: asks only where an ambient target is production', { options: { scriptCheck: 'production' } }, async ($, on) => {
    const { ran, asked } = engine(on, { files: UP })
    let context = 'dev'
    on('process.run', () => exited(0, `${context}\n`))
    expect(refused(await $.tool.call({ tool: 'Bash', command: './up.sh' }))).toBeUndefined()
    expect(asked.length).toBe(0)
    context = 'prod-eu'
    expect(refused(await $.tool.call({ tool: 'Bash', command: './up.sh' }))).toContain('did not run it')
    expect(asked[0]).toContain('PRODUCTION: prod-eu')
    expect(ran).toEqual(['./up.sh'])
  })
})

describe('the other switches', () => {
  test('terraformGate off: apply runs without a plan', { options: { terraformGate: false } }, async ($, on) => {
    const { ran } = engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    expect(refused(await $.tool.call({ tool: 'Bash', command: 'terraform apply -auto-approve' }))).toBeUndefined()
    expect(ran.length).toBe(1)
  })

  test('secretGuard off: a command that prints Secret data runs', { options: { secretGuard: false } }, async ($, on) => {
    const { ran } = engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    expect(refused(await $.tool.call({ tool: 'Bash', command: 'kubectl --context dev get secret app -o yaml' }))).toBeUndefined()
    expect(ran.length).toBe(1)
  })

  test('with secretTools off, a refusal names no tool that is not there', { options: { secretTools: false } }, async ($, on) => {
    engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    const r = refused(await $.tool.call({ tool: 'Bash', command: 'kubectl --context dev get secret app -o yaml' }))
    expect(r).toContain('Secret data')
    expect(r).not.toContain('secret_rotate')
  })

  test('registers only the tools switched on', { options: { secretTools: false, watchTools: false } }, async ($, on) => {
    engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    const tools = registry(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    expect(tools).toEqual(['config_facts'])
  })

  test('registers them all by default', async ($, on) => {
    engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    const tools = registry(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    expect(tools).toEqual(['watch_start', 'watch_stop', 'secret_rotate', 'secret_set', 'secret_keys', 'leak_check', 'config_facts'])
  })

  test('targets: reads and shows only those listed', { options: { targets: 'kube' } }, async ($, on) => {
    const { reads } = engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    await $.tool.call({ tool: 'Bash', command: 'kubectl get pods' })
    expect(reads.some(p => p.includes('gh') || p.includes('gcloud') || p.includes('.aws'))).toBe(false)
    const ui = await $.ui.mount({ plugin: 'infra-handrail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /kube dev/ })).toBeDefined()
  })

  test('band off: no targets row', { options: { band: false } }, async ($, on) => {
    engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    await $.tool.call({ tool: 'Bash', command: 'kubectl get pods' })
    const ui = await $.ui.mount({ plugin: 'infra-handrail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ text: /kube dev/ })).toBeUndefined()
  })

  test('audit off: nothing is logged, and /timeline says so', { options: { audit: false } }, async ($, on) => {
    const { audit } = engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    await $.tool.call({ tool: 'Bash', command: 'kubectl annotate ns default x=1' })
    expect(audit().length).toBe(0)
    const r = await $.command.run({ command: 'timeline', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(r.text).toContain('audit option is off')
  })
})

describe('the permission check', () => {
  // The person runs the script in the dialog (no surface draws the pane); the
  // permission mode beneath asks about the call.
  function asking(on: On) {
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'ask', reason: 'the mode asks' }))
  }

  test('allows the call the person approved here', async ($, on) => {
    const { ran, audit } = engine(on, { files: UP, answer: 'Run it' })
    on('process.run', () => exited(0, 'dev\n'))
    asking(on)
    expect(refused(await $.tool.call({ tool: 'Bash', command: './up.sh' }))).toBeUndefined()
    expect(ran).toEqual(['./up.sh'])
    expect(audit().at(-1)?.note).toContain('the permission check asked')
  })

  test('approveAtPermissionCheck off: leaves it to the mode', { options: { approveAtPermissionCheck: false } }, async ($, on) => {
    const { ran, asked } = engine(on, { files: UP, answer: 'Run it' })
    on('process.run', () => exited(0, 'dev\n'))
    asking(on)
    const r = refused(await $.tool.call({ tool: 'Bash', command: './up.sh' }))
    // The person ran it in the dialog; the ask at the permission check stood.
    expect(asked.length).toBe(1)
    expect(r).toBeDefined()
    expect(r).not.toContain('did not run it')
    expect(ran.length).toBe(0)
  })
})

describe('config_facts', () => {
  test('reads profile and context names, never values', () => {
    expect(awsProfiles('[default]\nregion = x\n[profile prod-admin]\nrole_arn = arn\n')).toEqual(['default', 'prod-admin'])
    expect(awsProfiles('[ci]\naws_secret_access_key = abc\n')).toEqual(['ci'])
    const argocd = 'contexts:\n- name: cd.prod.example\n  server: cd.prod.example\n- name: cd.dev.example\ncurrent-context: cd.dev.example\n'
    expect(argocdContexts(argocd)).toEqual(['cd.prod.example', 'cd.dev.example'])
  })

  test('counts each CLI in zsh, fish and bash history, and the writes that name no target', () => {
    const zsh = ': 1700000000:0;kubectl get pods\n: 1700000001:0;kubectl apply -f x.yaml\n: 1700000002:0;helm upgrade api ./c --kube-context dev\n'
    const fish = '- cmd: kubecolor delete pod web\n  when: 1700000003\n- cmd: ./deploy.sh prod\n  when: 1700000004\n'
    const commands = [...historyCommands(zsh), ...historyCommands(fish), ...historyCommands('terraform plan\n')]
    expect(commands).toEqual(['kubectl get pods', 'kubectl apply -f x.yaml', 'helm upgrade api ./c --kube-context dev', 'kubecolor delete pod web', './deploy.sh prod', 'terraform plan'])
    const u = usage(commands, HOME)
    expect(u.clis.kubectl).toEqual({ runs: 3, writes: 2, writesNamingNoTarget: 2 })
    expect(u.clis.helm).toEqual({ runs: 1, writes: 1, writesNamingNoTarget: 0 })
    expect(u.scriptRuns).toBe(1)
  })

  test('sums the audit log by outcome and by the guard that refused', () => {
    const row = (outcome: AuditEntry['outcome'], note?: string): AuditEntry => ({ at: '2026-11-01T00:00:00Z', session: 's', cwd: '/w', command: 'x', targets: null, outcome, note, ms: 1 })
    const s = auditSummary([
      row('refused', 'infra-handrail: refused, a command that changes a cluster must name its target with kubectl --context (x).'),
      row('refused', 'infra-handrail: /w/up.sh would run 1 command(s) that take the ambient target, so the person is reviewing it'),
      row('refused', 'infra-handrail: refused terraform apply without a saved plan.'),
      row('confirmed'),
    ])
    expect(s.outcomes).toEqual({ refused: 3, confirmed: 1 })
    expect(s.refusedBy).toMatchObject({ namedTargets: 1, scriptCheck: 1, terraformGate: 1, secretGuard: 0 })
  })

  test('answers names and counts as the tool, and no history line', async ($, on) => {
    engine(on, { files: { [`${HOME}/.zsh_history`]: ': 1700000000:0;kubectl delete pod web --token=abc123\n' } })
    on('process.run', ($, e) => {
      // As sh answers when the last CLI it looks up is missing.
      if (e.argv[0] === 'sh') return exited(1, 'kubectl\nhelm\n')
      if (e.argv.join(' ') === 'kubectl config get-contexts -o name') return exited(0, 'dev\nprod-eu\n')
      return exited(0, 'dev\n')
    })
    const r = await $.tool.call({ tool: 'mcp__infra-handrail__config_facts' })
    const text = JSON.stringify(r.result)
    const facts = JSON.parse(String(r.result)) as {
      installed: Record<string, boolean>
      targets: { kubeContexts: { name: string; production: boolean }[] }
      history: { clis: Record<string, { runs: number }> }
    }
    expect(facts.installed).toMatchObject({ kubectl: true, helm: true, terraform: false })
    expect(facts.targets.kubeContexts).toEqual([{ name: 'dev', production: false }, { name: 'prod-eu', production: true }])
    expect(facts.history.clis.kubectl?.runs).toBe(1)
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('delete pod')
  })
})

describe('changes to the mod itself', () => {
  const SAVE = `printf '%s' '{"namedTargets":"off"}' | claude plugin configure infra-handrail@jerrytech --values-stdin`

  test('asks before Claude saves its options or turns it off, whatever the options say', { options: { namedTargets: 'off', scriptCheck: 'off', audit: false } }, async ($, on) => {
    const { ran, asked } = engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    expect(refused(await $.tool.call({ tool: 'Bash', command: SAVE }))).toContain('did not allow this change')
    expect(refused(await $.tool.call({ tool: 'Bash', command: 'claude plugin disable infra-handrail@jerrytech' }))).toContain('did not allow')
    expect(asked[0]).toContain(`Command: ${SAVE}`)
    expect(ran.length).toBe(0)
  })

  test('runs the change once the person allows it, and logs it', async ($, on) => {
    const { ran, audit } = engine(on, { answer: 'Allow' })
    on('process.run', () => exited(0, 'dev\n'))
    expect(refused(await $.tool.call({ tool: 'Bash', command: SAVE }))).toBeUndefined()
    expect(ran).toEqual([SAVE])
    expect(audit().at(-1)).toMatchObject({ outcome: 'confirmed', note: 'the person allowed a change to infra-handrail' })
  })

  test('lets reading its options, and changing another plugin, through', async ($, on) => {
    const { ran, asked } = engine(on)
    on('process.run', () => exited(0, 'dev\n'))
    await $.tool.call({ tool: 'Bash', command: 'claude plugin configure infra-handrail@jerrytech --json' })
    await $.tool.call({ tool: 'Bash', command: `printf '{}' | claude plugin configure other@market --values-stdin` })
    expect(asked.length).toBe(0)
    expect(ran.length).toBe(2)
  })
})
