from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "assets" / "icons"
STORE_DIR = ROOT / "store-assets"
GREEN = (121, 214, 154, 255)
GREEN_LIGHT = (174, 241, 196, 255)
INK = (14, 24, 18, 255)
SURFACE = (24, 37, 29, 255)
LINE = (52, 75, 60, 255)


def vertical_gradient(size, top, bottom):
    image = Image.new("RGBA", size)
    pixels = image.load()
    for y in range(size[1]):
        ratio = y / max(1, size[1] - 1)
        color = tuple(round(top[i] * (1 - ratio) + bottom[i] * ratio) for i in range(4))
        for x in range(size[0]):
            pixels[x, y] = color
    return image


def build_icon(size=1024):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scale = size / 128
    box = tuple(round(value * scale) for value in (16, 16, 112, 112))
    radius = round(25 * scale)

    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(box, radius=radius, fill=(0, 0, 0, 105))
    shadow = shadow.filter(ImageFilter.GaussianBlur(round(4 * scale)))
    image.alpha_composite(shadow, (0, round(2 * scale)))

    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    gradient = vertical_gradient(image.size, (30, 53, 39, 255), (12, 22, 16, 255))
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", image.size), mask))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(box, radius=radius, outline=(83, 125, 96, 255), width=round(1.5 * scale))

    line_width = round(6 * scale)
    for y, end in ((48, 79), (64, 73), (80, 65)):
        draw.line((36 * scale, y * scale, end * scale, y * scale), fill=GREEN_LIGHT, width=line_width)
        draw.ellipse(((36 * scale - line_width / 2), (y * scale - line_width / 2),
                      (36 * scale + line_width / 2), (y * scale + line_width / 2)), fill=GREEN_LIGHT)
        draw.ellipse(((end * scale - line_width / 2), (y * scale - line_width / 2),
                      (end * scale + line_width / 2), (y * scale + line_width / 2)), fill=GREEN_LIGHT)

    plus_width = round(5 * scale)
    draw.line((85 * scale, 68 * scale, 85 * scale, 92 * scale), fill=GREEN, width=plus_width)
    draw.line((73 * scale, 80 * scale, 97 * scale, 80 * scale), fill=GREEN, width=plus_width)
    return image


def rounded_panel(size, box, radius, fill, outline=None, width=1):
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    return layer


def build_promo(width, height):
    image = vertical_gradient((width, height), (26, 46, 34, 255), (8, 15, 11, 255))
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-width * .08, -height * .35, width * .55, height * 1.05), fill=(80, 205, 125, 72))
    image = Image.alpha_composite(image, glow.filter(ImageFilter.GaussianBlur(max(20, width // 16))))

    icon_size = round(height * .52)
    icon = build_icon(1024).resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    image.alpha_composite(icon, (round(width * .08), (height - icon_size) // 2))

    panel_box = (round(width * .48), round(height * .14), round(width * .94), round(height * .86))
    image.alpha_composite(rounded_panel(image.size, panel_box, round(height * .055), (15, 24, 18, 238), LINE, max(1, width // 440)))
    draw = ImageDraw.Draw(image)
    x1, y1, x2, y2 = panel_box
    draw.rounded_rectangle((x1 + 15, y1 + 15, x2 - 15, y1 + 34), radius=6, fill=(28, 43, 33, 255))
    for index, fraction in enumerate((.78, .61, .86)):
        y = y1 + 51 + index * round(height * .16)
        draw.rounded_rectangle((x1 + 15, y, x2 - 15, y + round(height * .11)), radius=8, fill=(26, 39, 30, 255))
        draw.rounded_rectangle((x1 + 25, y + 9, x1 + 25 + (x2 - x1 - 50) * fraction, y + 13), radius=2, fill=GREEN if index == 0 else (115, 139, 122, 255))
    return image


def main():
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    master = build_icon()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICON_DIR / f"icon-{size}.png", optimize=True)
    master.resize((128, 128), Image.Resampling.LANCZOS).save(STORE_DIR / "store-icon-128.png", optimize=True)
    build_promo(440, 280).save(STORE_DIR / "promo-small-440x280.png", optimize=True)
    build_promo(1400, 560).save(STORE_DIR / "promo-marquee-1400x560.png", optimize=True)
    print(f"Generated icons in {ICON_DIR} and promotional assets in {STORE_DIR}")


if __name__ == "__main__":
    main()
