# Scan findme.exe zlib streams (PYZ code objects) for raw route path constants
import re, zlib, collections

EXE = r"E:\soft\Knowly\resources\python-server\findme.exe"
OUT = r"E:\data\Knowly\analysis\pyz-routes.txt"

data = open(EXE, "rb").read()
print("exe size:", len(data))

PREFIX = (b"api|qa|chat|tools|sessions|directories|scheduler|remote-control|config|agents|skills|"
          b"models|rag|knowledge|files|tasks|mcp|settings|auth|user|quota|search|upload|export|"
          b"import|version|health|env|terminal|image|cache|favorite|user-input|stream|toolbox|"
          b"python|ws|index|document|preview|folder|workspace|sandbox|subagent|memory|prompt|"
          b"history|conversation|message|embedding|vector|ocr|convert|browser|office|excel|"
          b"schedule|reminders|reminder|directories")
route_re = re.compile(rb"/(?:" + PREFIX + rb")/[A-Za-z0-9_/{}.\-]{0,60}|/(?:" + PREFIX + rb")(?![A-Za-z0-9_\-])", re.I)
paths = collections.Counter()
streams = 0

candidates = []
for magic in (b"\x78\x01", b"\x78\x5e", b"\x78\x9c", b"\x78\xda"):
    start = 0
    while True:
        i = data.find(magic, start)
        if i < 0:
            break
        candidates.append(i)
        start = i + 1
candidates.sort()
print("zlib candidates:", len(candidates))

for i in candidates:
    d = zlib.decompressobj()
    try:
        out = d.decompress(data[i:i + 400000])
    except Exception:
        continue
    if not out:
        continue
    streams += 1
    for m in route_re.findall(out):
        p = m.decode("ascii", "ignore")
        if len(p) > 70:
            continue
        paths[p] += 1

print("decompressed streams:", streams)
with open(OUT, "w", encoding="utf-8") as f:
    for p, c in sorted(paths.items()):
        f.write(f"{c}\t{p}\n")
print("unique route-ish literals:", len(paths))
