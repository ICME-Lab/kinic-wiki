"""Inspect exact times from the encoded deliverable, rather than preview renders."""
import array,concurrent.futures,json,math,subprocess,wave
from pathlib import Path
from PIL import Image,ImageDraw,ImageStat
root=Path(__file__).resolve().parent
out=root.parent/'build/NewFeaturesDemo/revised-review'
video=out.parent/'KinicWiki-new-features-revised.mp4'
cli=root/'node_modules/@remotion/cli/remotion-cli.js'
times=[1,1.8667,2,3.1333,4.4667,5.3667,5.5667,5.6,5.8333,6.2667,7.3,7.5,9.6667,10.4667,10.6667,10.7,10.9667,12,13.9667,14,14.3333,15,15.9,16.4,16.5667,16.6,16.6333,16.8667,18,19.4667]
def extract(t):
 file=out/f'encoded-{t:07.4f}.png'
 if file.exists() and file.stat().st_mtime>=video.stat().st_mtime:return file
 subprocess.run(['node',str(cli),'ffmpeg','-y','-ss',str(max(0,t-.0002)),'-i',str(video),'-frames:v','1','-s','402x874',str(file)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
 return file
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 files=list(pool.map(extract,times))
for page in range(2):
 canvas=Image.new('RGB',(402*5,910*3),'#161616');draw=ImageDraw.Draw(canvas)
 for i,file in enumerate(files[page*15:(page+1)*15]):
  x=i%5*402;y=i//5*910;canvas.paste(Image.open(file),(x,y+28));draw.text((x+8,y+7),f'{times[page*15+i]:.4f}s',fill='white')
 canvas.save(out/f'encoded-sheet-{page}.jpg')
decoded=out/'decoded'
decoded.mkdir(exist_ok=True)
subprocess.run(['node',str(cli),'ffmpeg','-y','-v','error','-i',str(video),'-an','-s','100x218',str(decoded/'frame-%04d.png')],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
frames=sorted(decoded.glob('frame-*.png'))
assert len(frames)==585,len(frames)
means=[sum(ImageStat.Stat(Image.open(file).convert('RGB')).mean)/3 for file in frames]
assert min(means)>5,min(means)
with wave.open(str(root/'public/revised-soundtrack.wav'),'rb') as f:
 samples=array.array('h',f.readframes(f.getnframes()))
 peak=max(abs(v) for v in samples)/32767;rms=math.sqrt(sum(v*v for v in samples)/len(samples))/32767
result={'decoded_frames':len(means),'min_frame_mean_rgb':min(means),'darkest_frame':means.index(min(means)),'audio_peak_dbfs':20*math.log10(peak),'audio_rms_dbfs':20*math.log10(rms),'audio_clipped_samples':sum(abs(v)>=32767 for v in samples),'review_times_seconds':times}
(out/'verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
