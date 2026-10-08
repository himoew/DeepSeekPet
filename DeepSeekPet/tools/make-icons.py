"""Regenerate Blue Fish Deskpet's icons from the artwork in web\\icon-source.png.

    python tools/make-icons.py

Needs Pillow (`pip install pillow`; the DSH runtime already has it).
Writes, next to the source:

    app-icon.png    256x256  window / taskbar icon
    tray-icon.png    64x64   tray icon (a head close-up reads far better small)
    avatar.png      128x128  portrait in the right-click chat menu (square; the page clips it)

Why it works the way it does: the artwork is a 240x216 chibi on a *light* background with a
soft vignette, so cutting the background out by colour does not work (the flood fill either
leaks into the white apron or stalls on the gradient). Instead the character's bounding box is
found from "colourful or dark" pixels (her hair, dress and outlines), a square is cropped
around it **from the original** (no padding, so there is no seam), and a soft circle mask is
applied. Keep this file ASCII-only so it prints cleanly in a cp936 console.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources", "app", "web")
SRC = os.path.join(WEB, "icon-source.png")


def content_box(im):
    """Bounding box of the character: colourful (hair/dress) or dark (outlines) pixels."""
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if (max(r, g, b) - min(r, g, b)) > 28 or max(r, g, b) < 130:
                xs.append(x)
                ys.append(y)
    pad = 14                      # include the white frills/apron, which have no colour
    return (max(0, min(xs) - pad), max(0, min(ys) - pad),
            min(w - 1, max(xs) + pad), min(h - 1, max(ys) + pad))


def square_crop(im, fx, fy, margin, box):
    """Square crop centred on (fx, fy); side = margin x the content height.

    The side has to be clamped to the image **before** the top-left corner is computed,
    otherwise the corner goes negative and the crop leaves the canvas (that bug cut her feet off).
    """
    w, h = im.size
    ch = box[3] - box[1] + 1
    side = int(min(ch * margin, w, h))
    left = int(round(min(max(fx - side / 2, 0), w - side)))
    top = int(round(min(max(fy - side / 2, 0), h - side)))
    return im.crop((left, top, left + side, top + side))


def circle(img, size, inset=3):
    big = 512
    b = img.resize((big, big), Image.LANCZOS)
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).ellipse((inset, inset, big - 1 - inset, big - 1 - inset), fill=255)
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(b, (0, 0), m.filter(ImageFilter.GaussianBlur(1.2)))
    return out.resize((size, size), Image.LANCZOS)


def main():
    if not os.path.exists(SRC):
        sys.exit("missing " + SRC)
    im = Image.open(SRC).convert("RGBA")
    box = content_box(im)
    cx = (box[0] + box[2]) / 2
    print("source %dx%d, content box %s" % (im.size[0], im.size[1], box))

    circle(square_crop(im, cx, (box[1] + box[3]) / 2, 1.15, box), 256).save(os.path.join(WEB, "app-icon.png"))
    head = square_crop(im, cx, box[1] + (box[3] - box[1] + 1) * 0.37, 0.74, box)
    circle(head, 64).save(os.path.join(WEB, "tray-icon.png"))
    head.resize((128, 128), Image.LANCZOS).save(os.path.join(WEB, "avatar.png"))
    # Multi-size .ico: for the executable and shortcuts on Windows. The runtime is plain
    # Electron (MIT), so re-branding its icon is legitimate -- see the optional rcedit
    # step in README.md.
    full = circle(square_crop(im, cx, (box[1] + box[3]) / 2, 1.15, box), 256)
    full.save(os.path.join(WEB, "app-icon.ico"),
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    for f in ("app-icon.png", "app-icon.ico", "tray-icon.png", "avatar.png"):
        p = os.path.join(WEB, f)
        print("wrote %-14s %6d bytes" % (f, os.path.getsize(p)))


if __name__ == "__main__":
    main()
