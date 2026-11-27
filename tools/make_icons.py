"""生成扩展图标：蓝紫渐变圆角方块 + 白色「考」字"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

C1 = (31, 111, 235)
C2 = (124, 58, 237)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\STHeiti.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
]


def gradient(size):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        col = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=col)
    return img


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255
    )
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return None


def make(size):
    base = gradient(size)
    img = rounded(base, int(size * 0.24))
    d2 = ImageDraw.Draw(img)

    font = load_font(int(size * 0.62))
    if font:
        text = "考"
        bbox = d2.textbbox((0, 0), text, font=font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d2.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1] - size * 0.02),
                text, font=font, fill=(255, 255, 255, 255))
    else:
        # 兜底：画一个对勾
        lw = max(2, int(size * 0.12))
        d2.line([(size * 0.24, size * 0.52), (size * 0.44, size * 0.72), (size * 0.78, size * 0.30)],
                fill=(255, 255, 255, 255), width=lw, joint="curve")

    # 白边提亮
    d3 = ImageDraw.Draw(img)
    d3.rounded_rectangle([1, 1, size - 2, size - 2], radius=int(size * 0.23),
                         outline=(255, 255, 255, 60), width=max(1, size // 48))
    return img


for s in (16, 32, 48, 128):
    p = os.path.join(OUT, f"icon{s}.png")
    make(s).save(p, "PNG")
    print("wrote", p)
