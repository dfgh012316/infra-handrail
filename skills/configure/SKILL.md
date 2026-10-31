---
name: configure
description: Set infra-handrail's options for the person from their environment, its audit log and their shell habits. Use when they ask to set up, configure, tune, loosen or tighten infra-handrail, or say one of its guards is in their way or not needed. Not a way past a refusal in the middle of a task.
---

# Configure infra-handrail

You propose option values from facts; the person decides; then you save what they agreed to. The options and their meanings are in the plugin's manifest, which step 1 prints, and in the README's Configuration section.

Run this only when the person asked for it. If a guard just refused something you were doing, report the refusal and stop: offering to loosen the guard is fine, configuring it on your own is not. Saving the options asks the person in any case (infra-handrail asks before any command changes it).

## 1. Read what is set now

```sh
claude plugin configure infra-handrail@jerrytech --json
```

`schema` holds every option with its description and default; `inputs` the values in force (`""` is unset: the default applies). If that id is not found, `claude plugin list` names the one installed. If none is, the session loads infra-handrail from a folder (`claude --plugin-dir`): its options are under `pluginConfigs["infra-handrail"].options` in the settings, which this CLI does not write. Go on to propose, and tell the person they can save the options after installing it, or in that settings file themselves.

## 2. Gather the facts

Call the `mcp__infra-handrail__config_facts` tool (it is deferred: load it through tool search). It answers names and counts only:

- `installed`: which infra CLIs are on PATH.
- `targets`: kube contexts, gcloud configurations (with their project), AWS profiles and argocd contexts, each with `production`: whether it matches the current `prodPattern`.
- `audit`: entries in infra-handrail's log, by outcome, and `refusedBy`: how often each guard refused.
- `history`: the shell history files counted, and per CLI `runs`, `writes` and `writesNamingNoTarget` (writes that left the context ambient); `scriptRuns`.

Do not read shell history, kubeconfig, gcloud or AWS files yourself, or run commands that print them: the tool exists so their contents stay out of the conversation. If a fact is missing (`undefined`), the CLI or file is not there; do not go looking.

## 3. Decide each option

Keep an option's current value when the facts do not decide it. For each change, note the facts that decided it.

| Option | Rule |
| --- | --- |
| `prodPattern` | List every target name from the facts. A name that does not say what it is (a customer, `live`, `main`, a project id): ask the person whether it is production. Write a case-insensitive pattern that matches the production names and none of the others, keeping `prod\|prd\|production` unless they object, and check it against every name before you propose it. |
| `targets` | Keep a target whose CLI is installed or appears in the history; drop the others (no aws CLI and no AWS profiles: drop `aws`). Keep `kube` while `namedTargets` or `scriptCheck` is on: they judge production by it. |
| `namedTargets` | `off` when no kubectl, helm, helmfile or argocd is installed or used. `always` when they rarely leave the context ambient (`writesNamingNoTarget` small next to `writes`), or work on a production context. `production` when most writes leave the context ambient and the production contexts are few. Say what it gives up: writes on every other context run unchecked, so one non-production environment's change landing on another (staging values on a dev release) is no longer caught. |
| `scriptCheck` | `off` when no infra CLI is installed or used. `always` when `scriptRuns` > 0 and any target is production. `production` when scripts run often, mostly on non-production targets, and `refusedBy.scriptCheck` is high. |
| `terraformGate` | `false` when none of terraform, tofu, terragrunt is installed or in the history. |
| `secretGuard` | `true` unless none of kubectl, helm, gcloud, aws is installed. |
| `allowHelmGet` | `true` only when the person says their chart values hold no credentials. Never infer it. |
| `secretTools` | `true` when they set or rotate Kubernetes Secrets with Claude, or want to. `false` when kubectl is not installed: four fewer tools in every session. |
| `watchTools` | `true` when they deploy to Kubernetes or use gh; otherwise `false`. |
| `band` | `true` unless they ask to hide it. |
| `audit` | `true` unless they ask otherwise. |
| `approveAtPermissionCheck` | `true`; `false` where their organization wants the permission mode alone to decide every call. |

From the audit log: a guard that refused often is worth a question. If those refusals were noise, prefer `production` to `off`; if some caught a real slip, keep it.

## 4. Propose

Show a table of the options that change: option, now, proposed, why (cite the facts, for example "helm: 43 writes, none named a context"). Say "everything else stays as it is". For each change that loosens a guard, say in a few words what it gives up. Ask for a yes or for edits, and wait for it.

## 5. Save

Only what the person agreed to, one call, only the options that change:

```sh
printf '%s' '{"namedTargets":"production","terraformGate":"false"}' | claude plugin configure infra-handrail@jerrytech --values-stdin
```

- Every value is a single-line string: booleans `"true"` / `"false"`, `targets` comma-separated (`"kube,gh"`), `prodPattern` as the expression with JSON escapes (`"prod|live|\\bp1\\b"`).
- infra-handrail asks the person before the command runs; that answer is theirs to give.
- Check with `claude plugin configure infra-handrail@jerrytech --json`, then tell them the running session keeps the old options until `/reload-plugins` or a restart.
