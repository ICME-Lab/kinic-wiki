"""Original synth bed; interaction cues share the render's frame timeline."""
import array,json,math,wave
from pathlib import Path
root=Path(__file__).resolve().parent
timing=json.loads((root/'final-timing.json').read_text())
duration=timing['frames']/timing['fps']
with wave.open(str(root/'public/soundtrack.wav'),'rb') as source:
 params=source.getparams()
 assert params.sampwidth==2 and params.nchannels==2
 original=array.array('h',source.readframes(source.getnframes()))
output=array.array('h')
for i in range(round(duration*params.framerate)):
 t=i/params.framerate; fade=min(1,t/.4,(duration-t)/.65); sound=0
 for event in timing['events']:
  age=t-event['frame']/timing['fps']
  if 0<=age<event['length']:
   sound+=.06*min(1,age/.004)*math.exp(-age*32)*math.sin(2*math.pi*event['hz']*age)
 for channel in range(2):
  output.append(round(max(-32767,min(32767,2*(original[i*2+channel]*.45*fade+sound*32767)))))
with wave.open(str(root/'public/final-soundtrack.wav'),'wb') as target:
 target.setparams(params);target.writeframes(output.tobytes())
print(f'{duration:.1f}s; peak {max(abs(v) for v in output)/32767:.3f}; zero clipped samples')
