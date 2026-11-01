"""Records the README's demo: drives Claude Code in a tmux pane and saves each screen it shows.

Run verify/demo/setup.sh first. This starts its own tmux server (socket handrail-demo,
150x44), launches Claude Code on the sandbox with this checkout as --plugin-dir, lets the
once-per-load notices print and clears them, then plays two asks while a thread saves a
frame each time the screen changes: $DEMO/frames.jsonl, for verify/demo/tosvg.py.

The fake key it pastes is random; nothing here reads a real credential.
"""
import json, os, random, string, subprocess, sys, threading, time

DEMO = os.environ.get('DEMO', '/tmp/handrail-demo')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TMUX = ['tmux', '-L', 'handrail-demo']


def cap(esc=False):
    return subprocess.run(TMUX + ['capture-pane', '-p', '-t', 'demo'] + (['-e'] if esc else []), capture_output=True, text=True).stdout


def keys(*k):
    subprocess.run(TMUX + ['send-keys', '-t', 'demo', *k])


def type_(s, delay=0.035):
    for ch in s:
        # A lone ';' would end the tmux command; '\;' is the character.
        keys('-l', '\\;' if ch == ';' else ch)
        time.sleep(delay)


def wait(text, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if text in cap():
            return True
        time.sleep(0.3)
    return False


def settle(start_timeout=20, idle=2.0, timeout=180):
    """Waits for a turn to start, then for no spinner for `idle` seconds."""
    end = time.time() + start_timeout
    while time.time() < end and 'esc to interrupt' not in cap():
        time.sleep(0.2)
    end, quiet = time.time() + timeout, None
    while time.time() < end:
        if 'esc to interrupt' in cap():
            quiet = None
        elif quiet is None:
            quiet = time.time()
        elif time.time() - quiet >= idle:
            return True
        time.sleep(0.2)
    return False


def recorder(path, stop):
    last, t0 = None, time.time()
    with open(path, 'w') as f:
        while not stop.is_set():
            s = cap(esc=True)
            if s != last:
                f.write(json.dumps({'t': round(time.time() - t0, 3), 's': s}) + '\n')
                f.flush()
                last = s
            time.sleep(0.08)


def need(ok, what):
    print(time.strftime('%H:%M:%S'), what, ok, flush=True)
    if not ok:
        sys.exit(f'stopped: {what}')


subprocess.run(TMUX + ['kill-server'], capture_output=True)
subprocess.run(TMUX + ['-f', f'{DEMO}/tmux.conf', 'new-session', '-d', '-s', 'demo', '-x', '150', '-y', '44',
                       '-c', f'{DEMO}/shop', '-e', 'PS1=$ ', 'bash', '--norc', '--noprofile'], check=True)
time.sleep(1)
type_(f'clear && KUBECONFIG={DEMO}/kubeconfig claude --setting-sources project,local '
      f'--plugin-dir {REPO} --settings {DEMO}/settings.json', delay=0)
keys('Enter')
if wait('trust this folder', 15):        # the sandbox folder, on its first run
    keys('Down'); keys('Enter')
need(wait('shift+tab', 60), 'session')
time.sleep(1)
type_('Say hi in three words.', delay=0); keys('Enter')
need(settle(), 'warm-up')
type_('/clear', delay=0); time.sleep(0.5); keys('Enter'); time.sleep(2.5)

stop = threading.Event()
rec = threading.Thread(target=recorder, args=(f'{DEMO}/frames.jsonl', stop))
rec.start()
try:
    time.sleep(2.5)                      # the band, before anything is asked
    type_('Deploy api to staging with ./scripts/deploy.sh api staging')
    time.sleep(0.6); keys('Enter')
    need(wait('Run against', 120), 'review pane')
    settle(start_timeout=2)
    time.sleep(5.0)                      # read the review
    keys('c')
    need(settle(), 'turn after cancel')
    time.sleep(3.0)
    type_("The payment provider rotated our key. Update PAYMENT_KEY in Secret api (namespace shop, context production). I'll paste the value.")
    time.sleep(0.6); keys('Enter')
    need(wait('Paste the new value', 120), 'paste field')
    time.sleep(2.5)
    type_('demo-new-key-' + ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(24)), delay=0.004)
    time.sleep(1.2); keys('Enter')
    need(settle(start_timeout=30), 'turn after paste')
    time.sleep(4.0)
finally:
    stop.set()
    rec.join()
print(f'frames in {DEMO}/frames.jsonl; tmux -L handrail-demo kill-server when done')
