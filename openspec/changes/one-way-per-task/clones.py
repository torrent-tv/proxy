"""Find duplicated blocks of normalized source lines across files.

Usage: python3 -I clones.py <window> <min_files_report> <root> <file>...
Prints clone groups: each group is a window hash seen in >= 2 places, merged
into maximal runs per pair of locations.
"""
import re
import sys
from collections import defaultdict

WINDOW = int(sys.argv[1])
ROOT = sys.argv[3]
FILES = sys.argv[4:]

TRIVIAL = re.compile(r"^[\s{}()\[\];,]*$|^(return;?|break;|continue;|\} else \{|\}\);?|\]\);?|\)\s*\{)$")


def normalize(line):
    s = line.strip()
    if s.startswith("//") or s.startswith("*") or s.startswith("/*"):
        return None
    s = re.sub(r"//.*$", "", s).strip()
    if not s or TRIVIAL.match(s):
        return None
    return re.sub(r"\s+", " ", s)


norm = {}
for f in FILES:
    try:
        lines = open(f, encoding="utf-8", errors="replace").read().split("\n")
    except OSError:
        continue
    out = []
    for i, line in enumerate(lines, 1):
        n = normalize(line)
        if n is not None:
            out.append((i, n))
    norm[f] = out

index = defaultdict(list)
for f, seq in norm.items():
    for k in range(len(seq) - WINDOW + 1):
        key = "\n".join(n for _, n in seq[k:k + WINDOW])
        if len(key) < WINDOW * 18:
            continue
        index[key].append((f, k))

# pair (fileA, kA, fileB, kB) runs
pairs = defaultdict(set)
for key, locs in index.items():
    if len(locs) < 2 or len(locs) > 8:
        continue
    for a in range(len(locs)):
        for b in range(a + 1, len(locs)):
            fa, ka = locs[a]
            fb, kb = locs[b]
            if fa == fb and abs(ka - kb) < WINDOW:
                continue
            pairs[(fa, fb, ka - kb)].add(ka)

results = []
for (fa, fb, delta), starts in pairs.items():
    starts = sorted(starts)
    run_start = prev = starts[0]
    for s in starts[1:] + [None]:
        if s is not None and s == prev + 1:
            prev = s
            continue
        length = prev - run_start + WINDOW
        la = norm[fa][run_start][0]
        la_end = norm[fa][prev + WINDOW - 1][0]
        lb = norm[fb][run_start - delta][0]
        lb_end = norm[fb][prev - delta + WINDOW - 1][0]
        results.append((length, fa.replace(ROOT, ""), la, la_end, fb.replace(ROOT, ""), lb, lb_end))
        if s is not None:
            run_start = prev = s

results.sort(reverse=True)
seen = set()
for length, fa, la, lae, fb, lb, lbe in results:
    sig = (fa, la // 10, fb, lb // 10)
    if sig in seen:
        continue
    seen.add(sig)
    print(f"{length:4d} lines  {fa}:{la}-{lae}  <=>  {fb}:{lb}-{lbe}")
