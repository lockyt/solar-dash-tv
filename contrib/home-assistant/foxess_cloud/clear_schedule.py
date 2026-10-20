#!/usr/bin/env python3
"""
Turn off the FoxESS Cloud scheduler ("time segments") so no battery schedule
carries over to the next day.

Why: Solar Dash (LG TV app) runs force charge/discharge overrides as FoxESS
scheduler segments, and those repeat every day. If the TV is off when an
override ends, nothing removes it. This runs at midnight from Home Assistant.

PowerSync is not affected: it controls the inverter over local Modbus
(remote control + work mode registers) and doesn't use scheduler segments.

Usage:  python3 clear_schedule.py          # disable scheduler if it's on
        python3 clear_schedule.py --check  # only report its state
Needs foxess_cloud_api_key and foxess_cloud_sn in /config/secrets.yaml.
"""
import hashlib
import json
import re
import sys
import time
import urllib.request

SECRETS = "/config/secrets.yaml"
BASE = "https://www.foxesscloud.com"


def secret(name):
    with open(SECRETS, encoding="utf-8") as f:
        m = re.search(r"^%s:\s*[\"']?([^\"'\n#]+?)[\"']?\s*$" % re.escape(name), f.read(), re.M)
    if not m:
        sys.exit("missing %s in secrets.yaml" % name)
    return m.group(1).strip()


def call(key, path, body):
    ts = str(int(time.time() * 1000))
    # FoxESS signs with the literal characters \r\n (as in their reference code)
    sig = hashlib.md5((path + r"\r\n" + key + r"\r\n" + ts).encode()).hexdigest()
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "token": key, "timestamp": ts, "signature": sig,
        "lang": "en", "User-Agent": "Mozilla/5.0 (HomeAssistant foxess-clear-schedule)",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    if data.get("errno") != 0:
        raise RuntimeError("FoxESS %s errno %s: %s" % (path, data.get("errno"), data.get("msg")))
    return data.get("result") or {}


def main():
    key, sn = secret("foxess_cloud_api_key"), secret("foxess_cloud_sn")
    flag = call(key, "/op/v1/device/scheduler/get/flag", {"deviceSN": sn})
    enabled = bool(flag.get("enable"))
    if "--check" in sys.argv or not enabled:
        print(json.dumps({"scheduler_enabled": enabled, "changed": False}))
        return
    time.sleep(1.2)  # FoxESS allows one call per second per endpoint
    call(key, "/op/v1/device/scheduler/set/flag", {"deviceSN": sn, "enable": 0})
    print(json.dumps({"scheduler_enabled": False, "changed": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # make failures visible to the automation
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
