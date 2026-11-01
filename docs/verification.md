# In-session checks

`claude plugin test .` runs the hooks in Claude Code's own engine, with external commands, dialogs and surfaces replaced by the tests' fakes. These checks run the mod in a real session, for what fakes cannot show: how the pane and the band draw, the keys, how Claude reacts to a refusal, and how other plugins' hooks stand around this mod's. Run them before a release, and note the Claude Code version (`claude --version`), the OS and the terminal.

## Safety

- Every check runs in a sandbox. The session's `KUBECONFIG` holds one context, `ig-verify-prod`, pointing at a port nothing listens on, so a command that slipped past the guards fails to connect. The Secret checks use a throwaway k3d cluster, named in each call. Your own kubeconfig is neither read nor changed.
- No check asks Claude to read or print a credential. The Secret value is a dummy the setup writes, and you, not Claude, put it where a notification carries it.
- Every command the checks ask Claude to run is refused before it runs, exits before it does anything (`up.sh`), fails to connect (section 8), or only reads a log.

## Setup

Needs `kubectl`; section 6 also needs `k3d` and Docker.

```sh
verify/setup.sh --cluster                     # without --cluster, skip section 6
claude plugin disable infra-handrail@jerrytech   # if it is installed: one copy runs
claude plugin disable infra-guard@jerrytech      # its former name, if that is installed
cd /tmp/ig-verify/work && KUBECONFIG=/tmp/ig-verify/kubeconfig claude --plugin-dir /path/to/infra-handrail
```

`verify/setup.sh` writes under `/tmp/ig-verify` (`IG=... verify/setup.sh` for another folder; the paths below then change with it). When done:

```sh
claude plugin enable infra-handrail@jerrytech
# k3d removes a deleted cluster from the kubeconfig KUBECONFIG names, else from yours:
KUBECONFIG=/tmp/ig-verify/k3d.yaml k3d cluster delete ig-verify; rm -rf /tmp/ig-verify
# Claude Code's own files for the sandbox session, a Monitor's raw output among them:
rm -rf "${CLAUDE_CODE_TMPDIR:-${TMPDIR:-/tmp}}/claude-$(id -u)/-tmp-ig-verify-work"
```

## Checks

Each row: what to say to Claude, and what passes. `/timeline` shows the audit rows the checks leave.

### 1. The band (0.2)

| Do | Pass |
| --- | --- |
| Start the session. | Above the prompt: `kube ig-verify-prod PROD`, in red. |

### 2. Named targets (0.2) and the Monitor tool (0.6)

| Ask Claude | Pass |
| --- | --- |
| Run `kubectl annotate namespace default ig-verify=1`. | Refused: `must name its target with kubectl --context (ambient kube-context: ig-verify-prod)`. |
| Use the Monitor tool to run `kubectl annotate namespace default ig-verify=1`. | The same refusal, for the Monitor call. |

### 3. More CLIs (0.6)

None needs the CLI installed: each is refused before it runs.

| Ask Claude | Pass |
| --- | --- |
| Run `tofu apply -auto-approve`. | Refused: `without a saved plan`, naming `tofu plan -out=tfplan`. |
| Run `helmfile -e prod apply`. | Refused: `helmfile --kube-context`, and `If the helmfile sets kubeContext itself, pass that same context.` |
| Run `kubecolor delete pod web`. | Refused: `kubectl --context`. |

### 4. The script review (0.8)

`up.sh` exits before it does anything; its line 8 runs helm on the ambient context.

| Do | Pass |
| --- | --- |
| Ask Claude: run `bash up.sh api sre`. In a terminal of 144 columns or more. | The call is refused and Claude says it waits. A pane opens (docked beside the transcript in the fullscreen layout, else above the prompt) with `$ bash up.sh api sre`, `in /tmp/ig-verify/work`, the ambient line with `PRODUCTION: ig-verify-prod`, `r: Run against production   c: Cancel`, then `up.sh  (8 lines; flagged: 8)` and the script whole: lines 1 to 8, line 8 drawn `▶` in red with `└ no explicit target` below it, all without scrolling. |
| Make the terminal under 20 rows tall; press ↓ and ↑. | The pane scrolls. |
| Press `c`. | The pane closes; Claude says the person did not run it. |
| Ask Claude to try again. While the pane is open, in your own terminal: `echo '# edited after the review' >> /tmp/ig-verify/work/up.sh`. Then press `r`. | Claude runs it again, and that run is refused: the pane opens anew, now with line 9, `# edited after the review`. (Claude may read the script first and stop on the change itself; tell it the line is yours and to run it.) Press `c`, then restore the script: `cp verify/up.sh /tmp/ig-verify/work/up.sh`. |
| Ask Claude to try again, then press `r`. | Claude is told the person pressed Run in infra-handrail's review pane, runs `bash up.sh api sre` again, unchanged, and it prints `would upgrade api with values-sre.yaml`. A dim line: `infra-handrail: allowed this command at the permission check, as you approved it`, unless section 5's note about `tool.check` applies. `/timeline`: `confirmed`, `run as the person reviewed them`. |
| Narrow the terminal below 144 columns; ask Claude to run it once more. | No pane; above the prompt, `infra-handrail: /tmp/ig-verify/work/up.sh waits for your review (ctrl+x tab)` with `[ Review ]` and `[ Cancel ]`. ctrl+x tab, then `v` (or Review): the pane opens at that width. Esc there cancels. |

Note how the approved rerun went through the permission check. Where a managed plugin sends `tool.check` past this mod (Claude Code says `infra-handrail: its tool.check hook was skipped`), the permission mode decides that rerun alone: in auto mode its classifier may refuse it.

### 5. The transcript scrub (0.7)

| Do | Pass |
| --- | --- |
| After any turn in which Claude called a tool, send another prompt. | Where a managed plugin sends `session.append` past this mod (Claude Code says `infra-handrail: its session.append hook was skipped`), the band shows `transcript scrub is off, …`; elsewhere, nothing. Either is a pass: note which. |

### 6. Secret tools and notifications (0.4 to 0.7)

Needs `verify/setup.sh --cluster`.

| Do | Pass |
| --- | --- |
| Ask Claude: use `secret_set` to set key `TOKEN` of Secret `app` in namespace `ig-verify`, context `k3d-ig-verify`, kubeconfig `/tmp/ig-verify/k3d.yaml`, from the file `/tmp/ig-verify/token.txt`. | A dialog names the key, the Secret and the file with its length and a fingerprint, never the value. Set: the result says `"verified": true` and holds no value. If section 5 showed the scrub off, the result also asks Claude to offer `leak_check`. |
| Ask Claude: start a Monitor on `tail -n0 -F /tmp/ig-verify/work/events.log`. Then, in your own terminal: `echo "deploy started" >> /tmp/ig-verify/work/events.log` | Claude receives `deploy started`. |
| In your own terminal: `echo "token=$(cat /tmp/ig-verify/token.txt)" >> /tmp/ig-verify/work/events.log` | You see `infra-handrail: withheld a background task's notification that carried a Secret value`. Claude receives `a background task's notification carried a Secret value this guard manages, so it was withheld`, and never the line. |
| Ask Claude to stop the monitor, then to run `leak_check`. | It answers file names only. `searched` lists `~/.claude` and Claude Code's temp folder, and `filesHoldingOne` names the monitor's raw output, `…/tasks/<id>.output`, which holds the line you appended. Nothing under `~/.claude`. |

### 7. The audit log

| Do | Pass |
| --- | --- |
| `/timeline` | A row for each refusal above, the review (`refused`, then `confirmed`) and the `secret_set` write, with the targets of the moment. No value anywhere. |

### 8. Options and the configure skill (1.0)

A session of its own, started with options. Quit the one above first.

```sh
cd /tmp/ig-verify/work && KUBECONFIG=/tmp/ig-verify/kubeconfig claude --plugin-dir /path/to/infra-handrail \
  --settings '{"pluginConfigs":{"infra-handrail":{"options":{"namedTargets":"production","targets":"kube,gh"}}}}'
```

| Do | Pass |
| --- | --- |
| Start it. | The band shows `kube` and `gh` only. |
| In your own terminal: `KUBECONFIG=/tmp/ig-verify/kubeconfig kubectl config use-context ig-verify-dev`. Ask Claude to run `kubectl annotate namespace default ig-verify=1`. | It runs, and fails to connect: on a context that is not production, `production` lets it through. |
| Ask Claude to run `kubectl config use-context ig-verify-prod`, then the annotate again. | The switch runs; the annotate is refused: `must name its target with kubectl --context`. |
| Ask Claude: configure infra-handrail for me, and propose before saving anything. | It loads the `configure` skill and calls `config_facts`: the CLIs you have, `ig-verify-dev` and `ig-verify-prod` with the latter marked production, counts from your history. It reads no history, kubeconfig or credentials file itself. It proposes a table with the facts behind each change and saves nothing. (With `--plugin-dir` it is not installed, so it also says it cannot save through `claude plugin configure`.) |
| Ask Claude to run `printf '%s' '{"band":"false"}' \| claude plugin configure infra-handrail@jerrytech --values-stdin`. | A dialog, `Claude is changing infra-handrail itself`, with the command. Cancel: refused, `the person did not allow this change`. |

## Left to the unit tests

- A check that throws before the command runs (0.7): only a line naming an infra CLI or a script is refused.
- An approved rerun whose ambient target changed after the review (0.8): reviewed again.
- A reload while a review or a paste field waits (1.0): closed, and Claude told that nothing ran. To see it in a session, save a change under `hooks/` while the pane is open: a `--plugin-dir` session reloads the module about 20 seconds later.
- Commands that print Secret data (0.2): asking Claude to run one is asking it to read a credential, so no check here does.
- Output carrying a known value, withheld from any tool (0.2).

## The README's demo

`docs/demo.svg` is recorded in a sandbox of its own: two throwaway k3d clusters as the contexts `staging` and `production`, a Secret with fake values, and a project whose deploy script takes the ambient context.

```sh
verify/demo/setup.sh                 # under /tmp/handrail-demo; your kubeconfig is not touched
python3 verify/demo/record.py        # drives Claude Code in a tmux server of its own, saves frames.jsonl
python3 verify/demo/tosvg.py /tmp/handrail-demo/frames.jsonl docs/demo.svg
tmux -L handrail-demo kill-server
KUBECONFIG=/tmp/handrail-demo/kubeconfig k3d cluster delete handrail-staging handrail-production; rm -rf /tmp/handrail-demo
```

Claude's replies differ from run to run; read the frames before replacing the file. `record.py` stops, naming the step, if the review or the paste field does not open.

## Recording a run

Note the run in the release's notes, and in the README's Tested line when it widens what was tested:

| Date | Version | Claude Code | OS, terminal | Sections passed | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-31 | 0.8.0 (as infra-guard) | 2.1.316 | Linux (WSL2) | 1, 2, 3, 4 (pane, cancel, approved rerun once), 5 (scrub on), 6, 7 | Not run: the edit after the review, the narrow terminal. Found: a Monitor's raw output file held the dummy value outside `leak_check`'s default folder (fixed in 1.0.0); the permission-check line read `infra-guard: infra-guard: …` (fixed). An administrator-managed plugin skipped `session.append` and `tool.check` once each at the start; both ran afterwards. |
| 2026-11-01 | 1.0.0 (as infra-guard) | 2.1.316 | Linux (WSL2), tmux at 200×50 and 120×50 | All, 1 to 7 | Driven from a second Claude Code session through tmux. Found and fixed during the run: the pane opened a third of the terminal tall, hiding line 8 below the fold (it now asks for the review's rows), and a reload left Claude waiting on a closed review (it is now told). `leak_check` named the monitor's `tasks/<id>.output` and nothing under `~/.claude`. The `tool.check` skip notice printed beside the approved rerun the mod allowed. |
| 2026-11-01 | 1.0.0 (infra-handrail) | 2.1.316 | Linux (WSL2), tmux at 200×50 | 8; then 1, 2 (Bash) and 4 (pane, approved rerun) on default options | Section 8 found `config_facts` reporting no CLI installed: `sh`'s loop exits 1 when the last CLI it looks up is missing, and that output was dropped (fixed, then passed). A dialog's header cut `infra-handrail` to 12 characters (now `handrail`). Sections 3, 5, 6 and 7 last ran as infra-guard 1.0.0; the code they run did not change but for the options, which default to it. |
| 2026-11-01 | 1.0.1 | 2.1.316 | Linux (WSL2), tmux at 150×44 | 1, 4 (pane, cancel) and the paste field of 6 (set, verified) | The README's demo, recorded with `verify/demo` on two k3d clusters, without your settings and CLAUDE.md (`--setting-sources project,local`). The release's fix (`terraform destroy` whose state cannot be read is refused) is covered by the unit tests. An administrator-managed plugin skipped `session.append` once, at the first prompt; the demo drops that row. |
