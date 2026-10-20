import base64
import json
import sys
import time

sys.path.insert(
    0, "/home/toxic/.local/share/uv/tools/kite-cli/lib/python3.12/site-packages"
)
sys.path.insert(0, "/home/toxic/estate/ranch/hatch/kite-cli/src")
from kite_cli.cli import connect, load_config
from kite_cli.gateway import GatewayError

gw = connect(load_config())
T = str(int(time.time()))
PROBE = "kite-cli-probe-" + T


def try_call(name, method, body):
    try:
        r = gw.call_json(method, body=body, timeout=30)
        print("OK", name, "->", json.dumps(r, ensure_ascii=False)[:400])
        return r
    except GatewayError as e:
        print("ERR", name, "->", str(e)[:200])
        return None


payload = base64.b64encode(("probe " + T + "\n").encode()).decode()

try_call(
    "write v3",
    "fs.write",
    {
        "path": PROBE + ".txt",
        "offset": 0,
        "data_base64": payload,
        "overwrite": True,
        "append": False,
        "create_parent": False,
        "eof": True,
    },
)
r = try_call("read back", "fs.read", {"path": PROBE + ".txt", "offset": 0, "len": 4096})
if r and r.get("data_base64"):
    print("READBACK:", base64.b64decode(r["data_base64"]).decode())
try_call("mkdir v2", "fs.mkdir", {"path": PROBE + "-dir", "recursive": True})
try_call(
    "rename v3",
    "fs.rename",
    {
        "source": PROBE + ".txt",
        "destination": PROBE + "-renamed.txt",
        "create_parent": False,
    },
)
try_call("stat renamed", "fs.stat", {"path": PROBE + "-renamed.txt"})
try_call(
    "delete renamed", "fs.delete", {"path": PROBE + "-renamed.txt", "recursive": True}
)
try_call("delete dir", "fs.delete", {"path": PROBE + "-dir", "recursive": True})
gw.close()
