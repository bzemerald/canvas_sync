"""halve.py in.png out.png [x y w h]: a half-size copy of a screenshot, so pixels are window
points (what mouse takes); with x y w h (in points), just that part, to look at closely."""
import sys

from PIL import Image

src, out, *box = sys.argv[1:]
im = Image.open(src)
im = im.resize((im.width // 2, im.height // 2))
if box:
    x, y, w, h = map(int, box)
    im = im.crop((x, y, x + w, y + h))
im.save(out)
