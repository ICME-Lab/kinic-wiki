"""Copy captured media into Remotion's public folder without changing pixels."""
import json
import shutil
from pathlib import Path

root=Path(__file__).resolve().parent
captures=root.parent/'build'/'NewFeaturesDemo'
public=root/'public'
public.mkdir(exist_ok=True)
assets={
    'demo-create.png':'edit-create.png',
    'frames/create-8.png':'edit-created.png',
    'frames/comment-1.png':'edit-comment-empty.png',
    'demo-comment.png':'edit-comment-posted.png',
    'demo-closed-list.png':'edit-closed-list.png',
    'widget.png':'edit-widget.png',
}
for source,destination in assets.items():
    shutil.copyfile(captures/source,public/destination)
attachments=captures/'widget-entry-attachments'
manifest=json.loads((attachments/'manifest.json').read_text())
after=next(a for test in manifest for a in test['attachments']
           if a['suggestedHumanReadableName'].startswith('demo-widget-entry-after'))
shutil.copyfile(attachments/after['exportedFileName'],public/'edit-widget-opened.png')
print('Prepared captured screens')
