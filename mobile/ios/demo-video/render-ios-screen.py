"""Keep the Simulator captures at their native iPhone screen size."""
import json
import subprocess
import array
import wave
from pathlib import Path

root = Path(__file__).resolve().parent
output = root.parent / 'build' / 'NewFeaturesDemo'
scenes = json.loads((root / 'new-scenes.json').read_text())
names = ['create', 'comment', 'close', 'widget']
duration = sum(scenes[name]['duration'] for name in names)
playlist = output / 'ios-screen-clips.txt'
playlist.write_text(''.join(f"file '{root / 'public' / f'new-{name}.mp4'}'\n" for name in names))
video = output / 'KinicWiki-new-features-ios.mp4'
audio = output / 'ios-screen-music.wav'
with wave.open(str(root / 'public' / 'soundtrack.wav'), 'rb') as source:
    params = source.getparams()
    assert params.sampwidth == 2
    samples = array.array('h', source.readframes(source.getnframes()))
count = round(duration * params.framerate)
mixed = array.array('h')
for frame in range(count):
    gain = 0.5 * min(1, frame / (0.5 * params.framerate), (count - frame) / (0.8 * params.framerate))
    for channel in range(params.nchannels):
        mixed.append(round(samples[(frame * params.nchannels + channel) % len(samples)] * gain))
with wave.open(str(audio), 'wb') as target:
    target.setparams(params)
    target.writeframes(mixed.tobytes())
subprocess.run([
    'node', str(root / 'node_modules' / '@remotion' / 'cli' / 'remotion-cli.js'),
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', str(playlist),
    '-i', str(audio),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
    '-t', str(duration), '-movflags', '+faststart', str(video),
], check=True)
print(video)
