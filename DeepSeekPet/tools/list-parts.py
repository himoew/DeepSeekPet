# -*- coding: utf-8 -*-
"""列出 model.json 的部件（调试用，避免 PowerShell 引号地狱）。"""
import json
import sys
from pathlib import Path

m = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(f"共 {len(m['parts'])} 个部件：")
for p in sorted(m["parts"], key=lambda p: p.get("z", 0)):
    box = ",".join(str(round(v, 1)) for v in p["box"])
    print(f"  z={p.get('z'):<5} id={p['id']:<20} tex={p['tex']:<22} box=[{box}]")
print("\nfeat.sprites 键：", list(m["feat"]["sprites"].keys()))
