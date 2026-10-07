"""Write files exactly as a brief gives them: put.py BRIEF PATH... (Create / Replace blocks)."""
import re, sys, os
lines = open(sys.argv[1]).read().split("\n")
for path in sys.argv[2:]:
    for i, l in enumerate(lines):
        if re.match(r"^(Create|Replace the whole file) `%s`:$" % re.escape(path), l) or l == "Replace the whole of `%s` with:" % path:
            j = i + 1
            while not re.match(r"^`{3,}", lines[j]): j += 1
            f = re.match(r"^(`{3,})", lines[j]).group(1); k = j + 1
            while lines[k] != f: k += 1
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            open(path, "w").write("".join(x + "\n" for x in lines[j+1:k]))
            print("wrote", path, k - j - 1, "lines"); break
    else:
        sys.exit("not in brief: " + path)
