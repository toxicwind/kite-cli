import json
import sys

sys.path.insert(
    0, "/home/toxic/.local/share/uv/tools/kite-cli/lib/python3.12/site-packages"
)
sys.path.insert(0, "/home/toxic/estate/ranch/hatch/kite-cli/src")
from kite_cli.cli import connect, load_config
from kite_cli.gateway import GatewayError

gw = connect(load_config())
P = "workspace/cron.d/runonce/probe-minimal-safety__runonce@2026-09-30T14:40:00.md"


def try_call(name, method, body):
    try:
        r = gw.call_json(method, body=body, timeout=30)
        print("OK", name, "->", json.dumps(r, ensure_ascii=False)[:700])
    except GatewayError as e:
        print("ERR", name, "->", str(e)[:180])


try_call("path+offset+len", "fs.read", {"path": P, "offset": 0, "len": 4096})
try_call("reads path", "fs.reads", {"reads": [{"path": P, "offset": 0, "len": 4096}]})
gw.close()
