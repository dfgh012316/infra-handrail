"""Turns verify/demo/record.py's frames into the README's animated SVG.

Each distinct row is drawn once in <defs>; each frame is a stack of <use> rows; a CSS animation
steps a film strip of frames through a clipped window. Idle stretches are shortened, the review,
the paste field and Claude's report are held, and a row with a plugin's "hook was skipped" notice
is dropped (it can name a plugin an administrator manages).

    python3 verify/demo/tosvg.py /tmp/handrail-demo/frames.jsonl docs/demo.svg
"""
import html, json, re, sys, unicodedata

COLS, ROWS = 150, 44
CW, LH, FS, PAD = 8.4, 17.0, 14, 14
BG, FG = '#0d1117', '#c9d1d9'
BASE16 = ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
          '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc']
IDLE_CAP, HOLD_CAP, LAST_HOLD = 1.6, 5.5, 5.0
HOLD_MARKS = ('Run against', 'Paste the new value', '"verified": true')
DROP_ROWS = ('hook was skipped',)       # removed; the rows below move up
BLANK_ROWS = ('❯ /clear',)              # the warm-up's clear: left as an empty row


def xterm256(n):
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return '#%02x%02x%02x' % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return '#%02x%02x%02x' % (v, v, v)


def width(ch):
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


def parse_row(line, st):
    """Cells of one row as runs: [(col, text, fg, bg, bold, dim, ul)], carrying SGR state in st."""
    runs, col, i = [], 0, 0
    cur = None
    while i < len(line):
        m = re.match(r'\x1b\[([0-9;:]*)m', line[i:])
        if m:
            codes = [int(c) if c else 0 for c in re.split('[;:]', m.group(1))] or [0]
            j = 0
            while j < len(codes):
                c = codes[j]
                if c == 0:
                    st.update(fg=None, bg=None, bold=False, dim=False, ul=False, inv=False)
                elif c == 1: st['bold'] = True
                elif c == 2: st['dim'] = True
                elif c == 22: st['bold'] = st['dim'] = False
                elif c == 4: st['ul'] = True
                elif c == 24: st['ul'] = False
                elif c == 7: st['inv'] = True
                elif c == 27: st['inv'] = False
                elif 30 <= c <= 37: st['fg'] = BASE16[c - 30]
                elif 90 <= c <= 97: st['fg'] = BASE16[c - 90 + 8]
                elif c == 39: st['fg'] = None
                elif 40 <= c <= 47: st['bg'] = BASE16[c - 40]
                elif 100 <= c <= 107: st['bg'] = BASE16[c - 100 + 8]
                elif c == 49: st['bg'] = None
                elif c in (38, 48) and j + 1 < len(codes):
                    key = 'fg' if c == 38 else 'bg'
                    if codes[j + 1] == 5 and j + 2 < len(codes):
                        st[key] = xterm256(codes[j + 2]); j += 2
                    elif codes[j + 1] == 2 and j + 4 < len(codes):
                        st[key] = '#%02x%02x%02x' % tuple(codes[j + 2:j + 5]); j += 4
                j += 1
            i += m.end()
            continue
        if line[i] == '\x1b':           # any other escape: skip it
            m = re.match(r'\x1b\[[0-9;?]*[A-Za-z]', line[i:])
            i += m.end() if m else 1
            continue
        ch = line[i]
        fg, bg = st['fg'], st['bg']
        if st['inv']:
            fg, bg = (bg or BG), (fg or FG)
        attrs = (fg, bg, st['bold'], st['dim'], st['ul'])
        if cur is None or tuple(cur[2:]) != attrs:
            cur = [col, '', *attrs]
            runs.append(cur)
        cur[1] += ch
        col += width(ch)
        i += 1
    return [tuple(r) for r in runs]


def plain(line):
    return re.sub(r'\x1b\[[0-9;:?]*[A-Za-z]', '', line)


def frame_rows(screen):
    lines = screen.split('\n')[:ROWS]
    lines += [''] * (ROWS - len(lines))
    kept = []
    for l in lines:
        p = plain(l)
        if any(d in p for d in DROP_ROWS):
            continue
        kept.append('' if p.strip() in BLANK_ROWS else l)
    kept += [''] * (ROWS - len(kept))
    st = dict(fg=None, bg=None, bold=False, dim=False, ul=False, inv=False)
    return [tuple(parse_row(l, st)) for l in kept]


def row_svg(runs):
    out = []
    for col, text, fg, bg, bold, dim, ul in runs:
        n = sum(width(c) for c in text)
        x = col * CW
        if bg:
            out.append(f'<rect x="{x:.1f}" y="0" width="{n * CW:.1f}" height="{LH}" fill="{bg}"/>')
        if not text.strip():
            continue
        lead = len(text) - len(text.lstrip(' '))
        body = text.strip(' ')
        nb = sum(width(c) for c in body)
        style = []
        if fg and fg != FG: style.append(f'fill="{fg}"')
        if bold: style.append('font-weight="bold"')
        if dim: style.append('opacity="0.6"')
        if ul: style.append('text-decoration="underline"')
        out.append(f'<text x="{x + lead * CW:.1f}" y="{LH * 0.78:.1f}" textLength="{nb * CW:.1f}" '
                   f'lengthAdjust="spacingAndGlyphs" {" ".join(style)}>{html.escape(body)}</text>')
    return ''.join(out)


def busy_free(rows):
    """A frame's content without the spinner row, so thinking reads as one held state."""
    return tuple(r for r in rows if not any('esc to interrupt' in t for _, t, *_ in r))


def main(src, dst):
    recs = [json.loads(l) for l in open(src)]
    frames = [(r['t'], frame_rows(r['s'])) for r in recs]
    # Durations: idle capped, key states held longer, thinking runs squeezed.
    durs = []
    for i, (t, rows) in enumerate(frames):
        d = (frames[i + 1][0] - t) if i + 1 < len(frames) else LAST_HOLD
        text = '\n'.join(''.join(x[1] for x in r) for r in rows)
        cap = HOLD_CAP if any(m in text for m in HOLD_MARKS) else IDLE_CAP
        durs.append(min(d, cap) if i + 1 < len(frames) else LAST_HOLD)
    i = 0
    while i < len(frames):              # a run that only changes the spinner: at most IDLE_CAP in all
        j = i
        while j + 1 < len(frames) and busy_free(frames[j + 1][1]) == busy_free(frames[i][1]):
            j += 1
        total = sum(durs[i:j + 1])
        if j > i and total > IDLE_CAP:
            scale = IDLE_CAP / total
            for k in range(i, j + 1):
                durs[k] *= scale
        i = j + 1
    # Drop frames too short to see; their time goes to the frame before.
    keep_f, keep_d = [], []
    for f, d in zip(frames, durs):
        if keep_f and d < 0.04:
            keep_d[-1] += d
            continue
        keep_f.append(f); keep_d.append(d)
    rows_seen, defs, seen_marks = {}, [], {}
    for _, rows in keep_f:
        for r in rows:
            if r and r not in rows_seen:
                rows_seen[r] = f'r{len(rows_seen)}'
                defs.append(f'<g id="{rows_seen[r]}">{row_svg(r)}</g>')
    W, H = COLS * CW, ROWS * LH
    FH = H + 3 * LH
    strip = []
    for n, (_, rows) in enumerate(keep_f):
        uses = ''.join(f'<use href="#{rows_seen[r]}" y="{k * LH:.0f}"/>' for k, r in enumerate(rows) if r)
        strip.append(f'<g transform="translate(0 {n * FH:.0f})">{uses}</g>')
    total = sum(keep_d)
    acc = 0.0
    for (_, rows), d in zip(keep_f, keep_d):
        text = '\n'.join(''.join(x[1] for x in r) for r in rows)
        for m in HOLD_MARKS:
            if m in text and m not in seen_marks:
                seen_marks[m] = acc
        acc += d
    print('marks at', {m: round(v, 1) for m, v in seen_marks.items()})
    kf, acc = [], 0.0
    for n, d in enumerate(keep_d):
        kf.append(f'{acc / total * 100:.3f}%{{transform:translateY({-n * FH:.0f}px)}}')
        acc += d
    kf.append(f'100%{{transform:translateY({-(len(keep_d) - 1) * FH:.0f}px)}}')
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" '
        f'viewBox="0 0 {W + 2 * PAD:.0f} {H + 2 * PAD:.0f}" width="{W + 2 * PAD:.0f}" height="{H + 2 * PAD:.0f}" '
        f'font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,\'Liberation Mono\',\'DejaVu Sans Mono\',monospace" '
        f'font-size="{FS}" fill="{FG}">'
        f'<style>text{{white-space:pre}}.s{{animation:p {total:.2f}s steps(1,end) infinite}}@keyframes p{{{"".join(kf)}}}</style>'
        f'<rect width="100%" height="100%" rx="8" fill="{BG}"/>'
        f'<defs>{"".join(defs)}<clipPath id="c"><rect width="{W:.0f}" height="{H:.0f}"/></clipPath></defs>'
        f'<g transform="translate({PAD} {PAD})" clip-path="url(#c)"><g class="s">{"".join(strip)}</g></g></svg>'
    )
    open(dst, 'w').write(svg)
    print(f'{len(recs)} recorded, {len(keep_f)} frames, {len(rows_seen)} rows, {total:.1f}s, {len(svg) / 1024:.0f} KB')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
