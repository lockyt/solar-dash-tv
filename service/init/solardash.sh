#!/bin/sh
# Solar Dash background daemon - installed to /var/lib/webosbrew/init.d/solardash
# by the Solar Dash app (Settings -> TV notifications). Runs at every boot as root,
# and again whenever the app reinstalls the service.
D=/media/developer/apps/usr/palm/services/com.solardash.tv.service
TOKENFILE=/tmp/solardash-daemon.token
LOG=/tmp/solardash-daemon.log

[ -f "$D/daemon.js" ] || exit 0

# The daemon runs as root, so make sure nothing else can modify its files
# (ipk installs leave them group/world-writable).
chmod -R go-w "$D"

# Only the newest supervisor keeps running: older ones see a different token and stop.
TOKEN="$(date +%s)-$$"
echo "$TOKEN" > "$TOKENFILE"

# Ask any running daemon to exit, then make sure it's gone.
wget -q -O /dev/null --post-data=quit http://127.0.0.1:8643/quit 2>/dev/null
sleep 1
for p in $(ps -e -o pid,args 2>/dev/null | grep "[s]olardash.tv.service/daemon.js" | awk '{print $1}'); do kill "$p" 2>/dev/null; done
sleep 1

(
    while [ "$(cat "$TOKENFILE" 2>/dev/null)" = "$TOKEN" ] && [ -f "$D/daemon.js" ]; do
        [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ] && tail -c 50000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
        /usr/bin/node "$D/daemon.js" >> "$LOG" 2>&1
        sleep 15
    done
) </dev/null >/dev/null 2>&1 &
