"""Original synth bed with restrained, frame-aligned interaction sounds."""
import array
import math
import wave
from pathlib import Path

root=Path(__file__).resolve().parent
with wave.open(str(root/'public/soundtrack.wav'),'rb') as source:
    params=source.getparams()
    assert params.sampwidth==2 and params.nchannels==2
    original=array.array('h',source.readframes(source.getnframes()))
events=[(2+2/30,620,.09),(2+115/30,880,.13),(8+80/30,1050,.13),(13+9/30,1280,.19),(17+83/30,760,.12)]
output=array.array('h')
for i in range(25*params.framerate):
    t=i/params.framerate
    fade=min(1,t/.4,(25-t)/.8)
    sound=0
    for at,hz,length in events:
        age=t-at
        if 0<=age<length:
            attack=min(1,age/.004)
            sound+=.06*attack*math.exp(-age*32)*math.sin(2*math.pi*hz*age)
    for channel in range(2):
        value=original[i*2+channel]*.45*fade+sound*32767
        output.append(round(max(-32767,min(32767,value))))
with wave.open(str(root/'public/edit-soundtrack.wav'),'wb') as target:
    target.setparams(params)
    target.writeframes(output.tobytes())
