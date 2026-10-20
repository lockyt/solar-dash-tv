"""Generate the app icons (no dependencies). Usage: python3 tools/gen-icons.py"""
import math, struct, sys, zlib, os

def png(path, size):
    bg, sun, bat = (11, 15, 20), (245, 184, 46), (61, 220, 151)
    px = []
    s = size
    for y in range(s):
        row = []
        for x in range(s):
            u, v = (x + 0.5) / s, (y + 0.5) / s
            c = bg
            # rounded square background
            r = 0.2
            dx, dy = max(abs(u - 0.5) - (0.5 - r), 0), max(abs(v - 0.5) - (0.5 - r), 0)
            if math.hypot(dx, dy) > r:
                row.append((0, 0, 0, 0)); continue
            # sun
            d = math.hypot(u - 0.36, v - 0.36)
            if d < 0.15: c = sun
            elif 0.2 < d < 0.27:
                a = math.atan2(v - 0.36, u - 0.36)
                if abs(((a / (math.pi / 4)) % 1) - 0.5) > 0.32: c = sun
            # battery
            if 0.52 < u < 0.82 and 0.48 < v < 0.86:
                inner = 0.56 < u < 0.78 and 0.52 < v < 0.82
                c = bat if (not inner or v > 0.62) else bg
            if 0.62 < u < 0.72 and 0.44 < v <= 0.48: c = bat
            row.append(c + (255,))
        px.append(row)
    raw = b''.join(b'\x00' + b''.join(struct.pack('BBBB', *p) for p in row) for row in px)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', s, s, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'img')
os.makedirs(root, exist_ok=True)
png(os.path.join(root, 'icon.png'), 80)
png(os.path.join(root, 'largeIcon.png'), 130)
print('icons written to', root)
