"""Restore native same-item screenshots from their retained capture files."""
import json,shutil
from pathlib import Path
root=Path(__file__).resolve().parent
source=root.parent/'build/NewFeaturesDemo/story-attachments'
for test in json.loads((source/'manifest.json').read_text()):
 for a in test['attachments']:
  name=a['suggestedHumanReadableName'].split('_0_')[0]
  if name.startswith('story-'):
   shutil.copyfile(source/a['exportedFileName'],root/'public'/f'{name}.png')
shutil.copyfile(source/'story-widget-clean.png',root/'public/story-widget-clean.png')
