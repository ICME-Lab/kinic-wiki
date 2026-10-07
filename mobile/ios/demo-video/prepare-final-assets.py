"""Copy named XCTest attachments without altering captured screen pixels."""
import json
import shutil
from pathlib import Path
root=Path(__file__).resolve().parent
source=None
def walk(value):
    if isinstance(value,dict):
        if str(value.get('suggestedHumanReadableName','')).startswith('final-'):
            name=value['suggestedHumanReadableName'].split('_0_')[0]
            shutil.copyfile(source/value['exportedFileName'],root/'public'/f'{name}.png')
            print(name)
        for v in value.values():walk(v)
    elif isinstance(value,list):
        for v in value:walk(v)
for folder in ['final-attachments3','final-composer-attachments']:
    source=root.parent/'build/NewFeaturesDemo'/folder
    walk(json.loads((source/'manifest.json').read_text()))
