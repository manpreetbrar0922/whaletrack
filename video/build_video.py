"""
WhaleTrack YouTube Video Builder
Generates AI voiceover + animated slides + assembles final MP4
"""

import asyncio
import edge_tts
import os
import json
from PIL import Image, ImageDraw, ImageFont
import numpy as np

# ── SCRIPT SECTIONS ──────────────────────────────────────────────────────────
SECTIONS = [
    {
        "id": "intro",
        "title": "WhaleTrack",
        "subtitle": "Track the Smart Money on Polymarket",
        "voiceover": (
            "What if you could see exactly what the smartest bettors on the internet are doing "
            "before anyone else does? "
            "On Polymarket, there are whales. People betting ten thousand, fifty thousand, sometimes a hundred thousand dollars "
            "on a single prediction. And they win — a lot. "
            "In this video, I'm going to show you the free tool that tracks every single one of their moves in real time. "
            "Let's get into it."
        ),
    },
    {
        "id": "what_is",
        "title": "What is Polymarket?",
        "subtitle": "$1B+ monthly volume in prediction markets",
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
        "title": "The Problem",
        "subtitle": "By the time you find out — it's too late",
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
        "title": "Introducing WhaleTrack",
        "subtitle": "whaletrack.app — Free to use",
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
        "id": "how_to",
        "title": "How to Use It",
        "subtitle": "Follow the smart money — step by step",
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
        "title": "WhaleTrack Premium",
        "subtitle": "Real-time alerts before Twitter — whaletrack.app/premium",
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
        "title": "Subscribe for Weekly Whale Recaps",
        "subtitle": "whaletrack.app — Free to start",
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

W, H = 1920, 1080
FPS = 30
FONT_PATH = '/System/Library/Fonts/HelveticaNeue.ttc'
BG_COLOR = '#0d1117'
BLUE = '#2563eb'
WHITE = '#ffffff'
GRAY = '#64748b'
LIGHT_GRAY = '#94a3b8'

# ── FONT HELPERS ──────────────────────────────────────────────────────────────
def font(size):
    return ImageFont.truetype(FONT_PATH, size)

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

# ── SLIDE GENERATOR ──────────────────────────────────────────────────────────
def make_slide(section, frame_num=0, total_frames=1):
    img = Image.new('RGB', (W, H), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Subtle blue glow background
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ov = ImageDraw.Draw(overlay)
    ov.ellipse([W//2-600, H//2-250, W//2+600, H//2+250], fill=(37, 99, 235, 12))
    img_rgba = img.convert('RGBA')
    img_rgba.alpha_composite(overlay)
    img = img_rgba.convert('RGB')
    draw = ImageDraw.Draw(img)

    # Top bar accent
    draw.rectangle([0, 0, W, 6], fill=BLUE)

    # Section badge (top left)
    badge_text = f"🐋 WhaleTrack"
    draw.text((60, 40), badge_text, font=font(28), fill=BLUE)

    # Progress dots (top right)
    ids = [s['id'] for s in SECTIONS]
    cur_idx = ids.index(section['id'])
    for i, _ in enumerate(SECTIONS):
        color = BLUE if i == cur_idx else GRAY
        x = W - 60 - (len(SECTIONS) - 1 - i) * 22
        draw.ellipse([x-6, 53-6, x+6, 53+6], fill=color)

    # Main title
    title = section['title']
    t_font = font(88) if len(title) < 22 else font(68)
    # Center title
    bbox = draw.textbbox((0, 0), title, font=t_font)
    tw = bbox[2] - bbox[0]
    draw.text(((W - tw) // 2, 360), title, font=t_font, fill=WHITE)

    # Blue divider line
    line_w = min(tw + 100, 900)
    draw.rectangle([(W - line_w) // 2, 480, (W + line_w) // 2, 484], fill=BLUE)

    # Subtitle
    subtitle = section['subtitle']
    s_font = font(42)
    bbox2 = draw.textbbox((0, 0), subtitle, font=s_font)
    sw = bbox2[2] - bbox2[0]
    draw.text(((W - sw) // 2, 510), subtitle, font=s_font, fill=LIGHT_GRAY)

    # Bottom URL
    url_font = font(32)
    draw.text((60, H - 70), 'whaletrack.app', font=url_font, fill=BLUE)

    # Bottom right - subscribe nudge on last slide
    if section['id'] == 'outro':
        sub_font = font(32)
        sub_text = '⬆ Subscribe for weekly whale recaps'
        bbox3 = draw.textbbox((0, 0), sub_text, font=sub_font)
        draw.text((W - bbox3[2] - bbox3[0] - 60, H - 70), sub_text, font=sub_font, fill=LIGHT_GRAY)

    return np.array(img)

# ── GENERATE VOICEOVER ────────────────────────────────────────────────────────
async def generate_voiceovers():
    print("🎙  Generating AI voiceovers...")
    for s in SECTIONS:
        path = f"audio_{s['id']}.mp3"
        if os.path.exists(path):
            print(f"  ✓ {s['id']} (cached)")
            continue
        communicate = edge_tts.Communicate(
            s['voiceover'],
            voice='en-US-AndrewNeural',
            rate='+8%',
            pitch='+0Hz'
        )
        await communicate.save(path)
        print(f"  ✓ {s['id']}")
    print("✅ All voiceovers done\n")

# ── GET AUDIO DURATION ────────────────────────────────────────────────────────
def get_duration(path):
    from moviepy.editor import AudioFileClip
    clip = AudioFileClip(path)
    d = clip.duration
    clip.close()
    return d

# ── BUILD VIDEO ───────────────────────────────────────────────────────────────
def build_video():
    from moviepy.editor import (
        ImageClip, AudioFileClip, concatenate_videoclips,
        CompositeVideoClip, VideoFileClip
    )

    print("🎬 Building video clips...")
    clips = []

    for s in SECTIONS:
        audio_path = f"audio_{s['id']}.mp3"
        duration = get_duration(audio_path)

        # Add 0.3s pause after each section
        duration += 0.3

        # Make slide frame
        frame = make_slide(s)
        img_clip = ImageClip(frame, duration=duration)

        # Attach audio
        audio = AudioFileClip(audio_path)
        img_clip = img_clip.set_audio(audio)

        clips.append(img_clip)
        print(f"  ✓ {s['id']} — {duration:.1f}s")

    # Concatenate all clips
    print("\n🔗 Concatenating clips...")
    final = concatenate_videoclips(clips, method='compose')

    print(f"\n📹 Total duration: {final.duration:.1f}s ({final.duration/60:.1f} min)")
    print("💾 Exporting MP4... (this takes ~2 min)")

    final.write_videofile(
        'whaletrack_video.mp4',
        fps=FPS,
        codec='libx264',
        audio_codec='aac',
        bitrate='4000k',
        audio_bitrate='192k',
        preset='fast',
        logger='bar'
    )

    print("\n✅ Video ready: video/whaletrack_video.mp4")
    print(f"   Duration: {final.duration/60:.1f} minutes")
    print(f"   Resolution: {W}x{H}")

# ── MAIN ──────────────────────────────────────────────────────────────────────
async def main():
    os.chdir('/Users/manpreetbrar/whaletrack/video')
    await generate_voiceovers()
    build_video()

if __name__ == '__main__':
    asyncio.run(main())
