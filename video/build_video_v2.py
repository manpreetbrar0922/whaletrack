"""
WhaleTrack YouTube Video v2
- Real whaletrack.app screenshots as backgrounds
- Ken Burns effect (slow pan + zoom)
- Text overlays per section
- AI voiceover (Andrew Neural)
"""

import asyncio
import edge_tts
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

W, H = 1920, 1080
FPS = 30
FONT = '/System/Library/Fonts/HelveticaNeue.ttc'
BG_COLOR = (13, 17, 23)
BLUE = (37, 99, 235)
WHITE = (255, 255, 255)
LIGHT_GRAY = (148, 163, 184)
DARK_OVERLAY = (0, 0, 0, 160)

# ── SECTIONS ─────────────────────────────────────────────────────────────────
SECTIONS = [
    {
        "id": "intro",
        "bg": "home.png",
        "zoom_from": 1.0, "zoom_to": 1.12,
        "pan_from": (0, 0), "pan_to": (0.03, 0.02),
        "title": "Track the Smart Money\non Polymarket",
        "highlight": "🐋  whaletrack.app — Free",
        "voiceover": (
            "What if you could see exactly what the smartest bettors on the internet are doing "
            "before anyone else does? "
            "On Polymarket, there are whales. People betting ten thousand, fifty thousand, sometimes a hundred thousand dollars "
            "on a single prediction. And they win a lot. "
            "In this video I'm going to show you the free tool that tracks every single one of their moves in real time. "
            "Let's get into it."
        ),
    },
    {
        "id": "polymarket",
        "bg": "home.png",
        "zoom_from": 1.1, "zoom_to": 1.0,
        "pan_from": (0.05, 0.0), "pan_to": (0.0, 0.0),
        "title": "What is Polymarket?",
        "highlight": "💰  $1 Billion+ monthly volume",
        "voiceover": (
            "Polymarket is the world's largest prediction market. "
            "People bet real money on real world events — elections, sports, crypto prices, even weather. "
            "The platform does over a billion dollars in volume every month. "
            "And unlike gambling, the best traders here consistently beat the market. "
            "These are the whales. And if you know what they're betting — you can copy them."
        ),
    },
    {
        "id": "problem",
        "bg": "leaderboard.png",
        "zoom_from": 1.05, "zoom_to": 1.15,
        "pan_from": (0.0, 0.0), "pan_to": (0.04, 0.03),
        "title": "The Problem",
        "highlight": "❌  By the time Twitter finds out — it's too late",
        "voiceover": (
            "The problem is — finding these whale trades is a nightmare. "
            "Polymarket doesn't show you who the top traders are. "
            "It doesn't show you their win rate. "
            "It doesn't alert you when someone drops fifty thousand dollars on a market. "
            "By the time you find out about a big bet on Twitter — it's already too late. "
            "The price has moved. The edge is gone."
        ),
    },
    {
        "id": "solution",
        "bg": "home.png",
        "zoom_from": 1.08, "zoom_to": 1.0,
        "pan_from": (0.02, 0.05), "pan_to": (0.0, 0.0),
        "title": "Introducing WhaleTrack",
        "highlight": "⚡  Real-time whale alerts — 10 min before Twitter",
        "voiceover": (
            "That's exactly why WhaleTrack was built. "
            "Go to whaletrack dot app — and you immediately see every big bet happening on Polymarket right now. "
            "You can see the whale's name, their rank on the leaderboard, their total P&L, their win rate, "
            "and the exact market they just bet on. "
            "See this trader — SomalianKing. He's up over two hundred thousand dollars on Polymarket. "
            "Win rate above sixty percent. And you can see every single bet he's made. "
            "This is public information — but nobody was pulling it together in one place. Until now. "
            "Every alert you see here — you're getting it ten minutes before it shows up on Twitter."
        ),
    },
    {
        "id": "somalianking",
        "bg": "somalianking.png",
        "zoom_from": 1.0, "zoom_to": 1.1,
        "pan_from": (0.0, 0.0), "pan_to": (0.0, 0.05),
        "title": "Follow the Top Whales",
        "highlight": "🏆  SomalianKing — Win Rate 65% — P&L $200K+",
        "voiceover": (
            "Here's how I use it. "
            "First — I check the leaderboard. Who's been winning consistently? "
            "High win rate, high profit, lots of trades. Those are the whales worth following. "
            "Then I look at their recent bets. What markets are they in? "
            "What's their position size? Are they going Yes or No? "
            "If three or four top whales are all betting the same direction on the same market — that's a strong signal. "
            "You don't need to be a genius. You just need to follow the smart money."
        ),
    },
    {
        "id": "premium",
        "bg": "premium.png",
        "zoom_from": 1.1, "zoom_to": 1.0,
        "pan_from": (0.0, 0.05), "pan_to": (0.0, 0.0),
        "title": "WhaleTrack Premium",
        "highlight": "📲  Telegram alerts with win rate, P&L & copy-bet link",
        "voiceover": (
            "Now the free tracker is great — but if you want real-time alerts the moment a whale places a bet, "
            "there's a premium Telegram channel. "
            "Every alert includes the whale's name, their win rate, their total P&L, "
            "and a direct link to copy the bet on Polymarket. "
            "You're getting this ten minutes before it hits Twitter. That's the edge. "
            "Link is in the description."
        ),
    },
    {
        "id": "outro",
        "bg": "whale_tracker.png",
        "zoom_from": 1.05, "zoom_to": 1.15,
        "pan_from": (0.0, 0.0), "pan_to": (0.03, 0.04),
        "title": "Start Tracking Whales Free",
        "highlight": "🐋  whaletrack.app  |  Subscribe for weekly recaps",
        "voiceover": (
            "Polymarket is the most transparent betting market in the world. "
            "The data is all public. WhaleTrack just makes it easy to act on. "
            "Go to whaletrack dot app — it's completely free to start. "
            "If you found this useful, subscribe — I post weekly whale recaps, "
            "big bet breakdowns, and market analysis every week. "
            "I'll see you in the next one."
        ),
    },
]

def font(size):
    return ImageFont.truetype(FONT, size)

def apply_ken_burns(img_pil, progress, zoom_from, zoom_to, pan_from, pan_to):
    """Slow zoom + pan effect on a PIL image"""
    zoom = zoom_from + (zoom_to - zoom_from) * progress
    pan_x = pan_from[0] + (pan_to[0] - pan_from[0]) * progress
    pan_y = pan_from[1] + (pan_to[1] - pan_from[1]) * progress

    iw, ih = img_pil.size
    crop_w = int(iw / zoom)
    crop_h = int(ih / zoom)

    max_ox = iw - crop_w
    max_oy = ih - crop_h
    ox = int(pan_x * max_ox)
    oy = int(pan_y * max_oy)

    cropped = img_pil.crop((ox, oy, ox + crop_w, oy + crop_h))
    return cropped.resize((W, H), Image.LANCZOS)

def add_overlay_and_text(img_pil, section):
    """Show screenshot at full color — just blue top bar + small watermark"""
    img = img_pil.copy()

    # Very slight brightness boost to make colors vivid
    enhancer = ImageEnhance.Brightness(img)
    img = enhancer.enhance(0.95)

    draw = ImageDraw.Draw(img)

    # Top blue accent bar only
    draw.rectangle([0, 0, W, 7], fill=BLUE)

    # Small watermark bottom right
    wf = font(30)
    draw.text((W - 300, H - 52), 'whaletrack.app', font=wf, fill=(255, 255, 255))

    return img

async def generate_voiceovers():
    print('🎙  Generating AI voiceovers...')
    for s in SECTIONS:
        path = f"audio_{s['id']}.mp3"
        if os.path.exists(path):
            print(f'  ✓ {s["id"]} (cached)')
            continue
        comm = edge_tts.Communicate(s['voiceover'], voice='en-US-AndrewNeural', rate='+8%')
        await comm.save(path)
        print(f'  ✓ {s["id"]}')
    print('✅ Voiceovers done\n')

def get_duration(path):
    from moviepy.editor import AudioFileClip
    c = AudioFileClip(path)
    d = c.duration
    c.close()
    return d

def build_video():
    from moviepy.editor import ImageClip, AudioFileClip, concatenate_videoclips
    from moviepy.video.VideoClip import VideoClip

    print('🎬 Building video clips...')
    clips = []
    screenshots_dir = 'screenshots'

    for s in SECTIONS:
        audio_path = f"audio_{s['id']}.mp3"
        duration = get_duration(audio_path) + 0.4

        # Load background screenshot
        bg_path = os.path.join(screenshots_dir, s['bg'])
        bg_pil = Image.open(bg_path).resize((W, H), Image.LANCZOS)

        total_frames = int(duration * FPS)

        def make_frame(t, _s=s, _bg=bg_pil, _dur=duration):
            progress = t / _dur
            # Ken Burns
            kb_frame = apply_ken_burns(
                _bg, progress,
                _s['zoom_from'], _s['zoom_to'],
                _s['pan_from'], _s['pan_to']
            )
            # Overlays + text
            final_frame = add_overlay_and_text(kb_frame, _s)

            # Fade in first 0.5s, fade out last 0.5s
            arr = np.array(final_frame).astype(float)
            if t < 0.5:
                arr = arr * (t / 0.5)
            elif t > _dur - 0.5:
                arr = arr * ((_dur - t) / 0.5)
            return arr.astype(np.uint8)

        clip = VideoClip(make_frame, duration=duration)
        audio = AudioFileClip(audio_path)
        clip = clip.set_audio(audio)
        clips.append(clip)
        print(f'  ✓ {s["id"]} — {duration:.1f}s')

    print('\n🔗 Concatenating...')
    final = concatenate_videoclips(clips, method='compose')
    print(f'📹 Total: {final.duration:.0f}s ({final.duration/60:.1f} min)')
    print('💾 Exporting... (~3 min)')

    final.write_videofile(
        'whaletrack_video_v2.mp4',
        fps=FPS,
        codec='libx264',
        audio_codec='aac',
        bitrate='6000k',
        audio_bitrate='192k',
        preset='fast',
        logger='bar'
    )

    print('\n✅ Video ready: video/whaletrack_video_v2.mp4')
    print(f'   Duration: {final.duration/60:.1f} min  |  Resolution: {W}x{H}')

async def main():
    os.chdir('/Users/manpreetbrar/whaletrack/video')
    await generate_voiceovers()
    build_video()

asyncio.run(main())
