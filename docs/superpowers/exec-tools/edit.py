"""Apply a brief's find/replace blocks for the given paths, exactly: edit.py BRIEF PATH..."""
import re, sys
lines = open(sys.argv[1]).read().split("\n")
def fence(i):
    while not re.match(r"^`{3,}", lines[i]): i += 1
    f = re.match(r"^(`{3,})", lines[i]).group(1); j = i + 1
    while lines[j] != f: j += 1
    return "".join(x + "\n" for x in lines[i+1:j]), j + 1
for path in sys.argv[2:]:
    n, i = 0, 0
    while i < len(lines):
        m = re.match(r"^In `%s`(?: \(change \d+ of \d+\))?, replace:$" % re.escape(path), lines[i])
        if m:
            old, i = fence(i + 1)
            assert lines[i+1] == "with:", lines[i:i+2]
            new, i = fence(i + 2)
            s = open(path).read()
            if s.count(old) != 1: sys.exit("%s: block %d matches %d times" % (path, n + 1, s.count(old)))
            open(path, "w").write(s.replace(old, new)); n += 1
            continue
        i += 1
    if n == 0: sys.exit("no edit blocks for " + path)
    print("edited", path, n, "block(s)")
