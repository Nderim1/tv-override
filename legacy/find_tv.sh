#!/bin/bash
# Finds a TCL TV on the local network and checks ADB. macOS.
# Usage: bash ~/projects/tv-override/find_tv.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/scan_result.txt"
exec > >(tee "$OUT") 2>&1

echo "=== scan $(date) ==="
IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
MYIP=$(ipconfig getifaddr "$IF")
GW=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
echo "interface=$IF myip=$MYIP gateway=$GW"
ifconfig "$IF" | grep 'inet '
PREFIX=${MYIP%.*}

echo "--- ping sweep $PREFIX.0/24 ---"
for i in $(seq 1 254); do ping -c 1 -t 1 "$PREFIX.$i" >/dev/null 2>&1 & done
wait

echo "--- mDNS (5s) ---"
for svc in _googlecast._tcp _androidtvremote2._tcp _adb._tcp _adb-tls-connect._tcp _airplay._tcp; do
  dns-sd -B $svc local. > /tmp/dnssd_$$.txt 2>&1 & P=$!; sleep 1.2; kill $P 2>/dev/null
  grep -E 'Add' /tmp/dnssd_$$.txt | sed "s/^/[$svc] /"
done
rm -f /tmp/dnssd_$$.txt

echo "--- hosts ---"
arp -an -i "$IF" | grep -v incomplete | awk '{gsub(/[()]/,"",$2); print $2, $4}' | sort -t. -k4 -n | uniq | while read ip mac; do
  [ "$ip" = "$MYIP" ] && continue
  case "$ip" in $PREFIX.255|224.*|239.*) continue;; esac
  ports=""
  for p in 5555 8008 8009 8060 6466 6467 9080; do nc -z -G 1 "$ip" $p >/dev/null 2>&1 && ports="$ports $p"; done
  name=$(dig +short +time=1 +tries=1 -x "$ip" 2>/dev/null | head -1)
  echo "HOST $ip mac=$mac rdns=$name ports=[$ports ]"
  case " $ports " in *" 8008 "*)
    echo "   cast: $(curl -s -m 3 "http://$ip:8008/setup/eureka_info?params=name,device_info" | head -c 600)";; esac
  case " $ports " in *" 8060 "*)
    echo "   roku: $(curl -s -m 3 "http://$ip:8060/query/device-info" | grep -E 'vendor-name|model-name|friendly-device-name|is-tv' | tr -d ' \n')";; esac
done

echo "--- adb ---"
ADB=$(command -v adb)
for c in "$HOME/Library/Android/sdk/platform-tools/adb" /opt/homebrew/bin/adb /usr/local/bin/adb; do
  [ -z "$ADB" ] && [ -x "$c" ] && ADB="$c"
done
echo "adb=$ADB"
if [ -n "$ADB" ]; then
  "$ADB" version | head -1
  grep '^HOST' "$OUT" | grep ' 5555' | awk '{print $2}' | while read ip; do
    echo "connecting $ip:5555"
    "$ADB" connect "$ip:5555"
    sleep 2
    "$ADB" devices -l
    "$ADB" -s "$ip:5555" shell 'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.product.device' 2>&1
  done
  "$ADB" devices -l
fi
echo "=== done; saved to $OUT ==="
