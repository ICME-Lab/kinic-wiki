import json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
output=root.parent/'build'/'NewFeaturesDemo'
markers=json.loads((output/'markers.json').read_text())
cli=root/'node_modules'/'@remotion'/'cli'/'remotion-cli.js'
scenes={}
for name,next_name in [('create','comment'),('comment','close'),('close','widget-setup')]:
    start=markers[name]; duration=markers[next_name]-start
    target=root/'public'/f'new-{name}.mp4'
    subprocess.run(['node',str(cli),'ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(start),'-i',str(output/'raw.mp4'),'-t',str(duration),'-r','30','-c:v','libx264','-pix_fmt','yuv420p','-an',str(target)],check=True)
    scenes[name]={'duration':duration}
widget=root/'public'/'new-widget.mp4'
if (output/'widget.png').exists():
    subprocess.run(['node',str(cli),'ffmpeg','-hide_banner','-loglevel','error','-y','-loop','1','-i',str(output/'widget.png'),'-t','7','-r','30','-c:v','libx264','-pix_fmt','yuv420p','-an',str(widget)],check=True)
scenes['widget']={'duration':7}
(root/'new-scenes.json').write_text(json.dumps(scenes,indent=2))
print(scenes)
