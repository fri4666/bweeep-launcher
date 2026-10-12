#!/usr/bin/env python3
"""Synthesizes the notice ding (an original bell-like tone) into notice.ogg.

    python3 tools/make-notice-sound.py [output.ogg]

Needs ffmpeg with libvorbis. Without ffmpeg, use the committed
src/main/resources/assets/bweeep_notify/sounds/notice.ogg as it is, or encode
the temporary WAV this script leaves next to the output with any other Ogg
Vorbis encoder (for example `oggenc -q 4 notice.wav`).
"""
import math
import os
import shutil
import struct
import subprocess
import sys
import wave

RATE = 44100
SECONDS = 1.1
# frequency ratio, level, decay per second: a bright struck-bell spectrum
PARTIALS = [(1.0, 1.00, 5.0), (2.0, 0.34, 7.5), (2.76, 0.24, 9.5), (4.07, 0.10, 14.0), (5.4, 0.05, 20.0)]
FUNDAMENTAL = 1318.5  # E6: the "ting"

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "main", "resources",
                           "assets", "bweeep_notify", "sounds", "notice.ogg")


def synthesize():
    samples = []
    count = int(RATE * SECONDS)
    for n in range(count):
        t = n / RATE
        value = 0.0
        for ratio, level, decay in PARTIALS:
            value += level * math.exp(-decay * t) * math.sin(2 * math.pi * FUNDAMENTAL * ratio * t)
        attack = min(1.0, t / 0.003)  # 3 ms, no click
        release = min(1.0, (SECONDS - t) / 0.05)
        samples.append(value * attack * release)
    peak = max(abs(s) for s in samples) or 1.0
    return [s / peak * 0.8 for s in samples]


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    wav = os.path.splitext(out)[0] + ".wav"
    with wave.open(wav, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in synthesize()))
    if not shutil.which("ffmpeg"):
        print(f"ffmpeg not found; wrote {wav} only. Encode it to Ogg Vorbis (mono) as {out}.")
        return 1
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libvorbis", "-q:a", "4",
                    "-ac", "1", "-ar", str(RATE), out], check=True)
    os.remove(wav)
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
