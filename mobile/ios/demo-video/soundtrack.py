"""Generate an original, restrained synth bed; no sampled or third-party music."""
import math, random, struct, wave
from pathlib import Path

rate = 48000
duration = 30
beat = 60 / 96
rng = random.Random(19)
chords = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
target = Path(__file__).parent / "public" / "soundtrack.wav"
target.parent.mkdir(exist_ok=True)
def frequency(midi):
    return 440 * 2 ** ((midi - 69) / 12)
with wave.open(str(target), "wb") as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(rate)
    buffer = bytearray()
    for i in range(rate * duration):
        t = i / rate
        chord = chords[int(t / (8 * beat)) % 4]
        pulse = t % beat
        eighth = t % (beat / 2)
        arp = frequency(chord[int(t / (beat / 2)) % 3] + 12)
        pad = sum(math.sin(2 * math.pi * frequency(n) * t) for n in chord) * .022
        pluck = math.sin(2 * math.pi * arp * t) * math.exp(-eighth * 13) * .075
        bass = math.sin(2 * math.pi * frequency(chord[0] - 12) * t) * .035
        kick = math.sin(2 * math.pi * (48 * pulse + 1.8 * (1 - math.exp(-pulse * 25)))) * math.exp(-pulse * 24) * .14
        hat = rng.uniform(-1, 1) * math.exp(-eighth * 120) * .024
        envelope = min(1, t / 1.2, (duration - t) / 1.8)
        value = int(max(-1, min(1, (pad + pluck + bass + kick + hat) * envelope)) * 32767)
        buffer.extend(struct.pack("<hh", value, value))
        if len(buffer) > 192000:
            output.writeframes(buffer)
            buffer.clear()
    output.writeframes(buffer)
print(target)
