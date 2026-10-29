#!/usr/bin/env python3
"""Decode bounded library images; output chronological, composited PNG frames.

Pillow is installed only in this project's root-owned app/vision-python directory.
The process never downloads URLs or writes extracted user frames to disk.
"""
import base64,bisect,io,json,os,resource,stat,sys,warnings
from pathlib import Path

ROOT=Path(os.environ.get('WHALE_ROOT','/home/qqwhale/whale')).resolve()
sys.path.insert(0,str(ROOT/'app/vision-python'))
resource.setrlimit(resource.RLIMIT_AS,(320*1024*1024,320*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(15,16))
from PIL import Image,ImageDraw,ImageOps
Image.MAX_IMAGE_PIXELS=12_000_000
warnings.simplefilter('error',Image.DecompressionBombWarning)

def checked_path(raw):
    library=(ROOT/'data/表情包/lib').resolve(strict=True)
    path=Path(raw).absolute()
    if not path.is_relative_to(library) or path==library:raise ValueError('图片不在图库中')
    current=library
    for part in path.relative_to(library).parts:
        current=current/part
        if current.is_symlink():raise ValueError('拒绝符号链接')
    st=path.stat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>10*1024*1024:raise ValueError('图片文件不合法或超过10MB')
    return path

def prepare(raw,limit=6):
    path=checked_path(raw)
    with Image.open(path) as image:
        if image.format not in ('PNG','JPEG','GIF','WEBP'):raise ValueError('不支持的图片内容格式')
        width,height=image.size
        if width*height>12_000_000:raise ValueError('图片像素过大')
        durations=[];frame=0;max_decoded_pixels=160_000_000
        while True:
            try:image.seek(frame)
            except EOFError:break
            if frame>=500 or (frame+1)*width*height>max_decoded_pixels:
                raise ValueError('动图帧数或累计像素超过安全上限，未冒充完整识别')
            durations.append(max(20,min(60_000,int(image.info.get('duration',100) or 100))))
            frame+=1
        total=len(durations);duration=sum(durations)
        # Time-based coverage, including first and last frame. Do not assume FPS.
        count=min(total,max(2,int(limit))) if total>1 else 1
        starts=[0]
        for value in durations:starts.append(starts[-1]+value)
        targets=[0] if count==1 else [round((duration-1)*i/(count-1)) for i in range(count)]
        indexes=sorted(set(min(total-1,bisect.bisect_right(starts,t)-1) for t in targets)|{0,total-1})
        frames=[]
        for index in indexes:
            image.seek(index)
            # Pillow seek composes GIF disposal/transparency against preceding frames.
            out=ImageOps.exif_transpose(image).convert('RGBA')
            out.thumbnail((960,960),Image.Resampling.LANCZOS)
            canvas=Image.new('RGB',out.size,'white');canvas.paste(out,mask=out.getchannel('A'))
            stream=io.BytesIO();canvas.save(stream,format='PNG',optimize=False)
            frames.append({'index':index,'timeMs':starts[index],'mime':'image/png','data':base64.b64encode(stream.getvalue()).decode()})
        return {'format':image.format,'width':width,'height':height,'animated':total>1,'totalFrames':total,'durationMs':duration if total>1 else 0,'frames':frames}

def fixtures():
    folder=ROOT/'data/表情包/lib/.vision-probes';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    Image.new('RGB',(96,96),'red').save(folder/'red.png')
    Image.new('RGB',(96,96),'blue').save(folder/'blue.png')
    frames=[]
    for x in range(12):
        frame=Image.new('RGB',(240,120),'white');draw=ImageDraw.Draw(frame)
        draw.ellipse((12+x*16,42,44+x*16,74),fill='red');frames.append(frame)
    frames[0].save(folder/'motion.gif',save_all=True,append_images=frames[1:],duration=[90,120,60,180,90,60,150,90,120,60,180,120],loop=0,disposal=2)
    for p in folder.iterdir():p.chmod(0o600)
    return {'ok':True}

if __name__=='__main__':
    try:
        result=fixtures() if sys.argv[1:]==['--fixtures'] else prepare(sys.argv[1],int(sys.argv[2]) if len(sys.argv)>2 else 6)
        print(json.dumps(result,separators=(',',':')))
    except Exception as error:
        print('图片解码失败: '+str(error),file=sys.stderr);sys.exit(1)
