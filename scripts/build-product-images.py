"""Build production WebP derivatives without changing the product PNG masters."""
from pathlib import Path
import re

from PIL import Image


root = Path(__file__).resolve().parents[1]
names = sorted(set(re.findall(
    r"/img/outfit/(?:web/)?([^/'\"]+)\.(?:png|webp)",
    (root / 'products.js').read_text(),
)))
output = root / 'img/outfit/web'
output.mkdir(exist_ok=True)
original_bytes = optimized_bytes = 0
for name in names:
    source = root / 'img/outfit' / f'{name}.png'
    target = output / f'{name}.webp'
    with Image.open(source) as master:
        pixels = master.convert('RGB')
        pixels.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
        pixels.save(target, 'WEBP', quality=88, method=6,
                    icc_profile=master.info.get('icc_profile', b''))
    original_bytes += source.stat().st_size
    optimized_bytes += target.stat().st_size
    print(target.relative_to(root))
print(f'{original_bytes} -> {optimized_bytes} bytes '
      f'({100 * (1 - optimized_bytes / original_bytes):.1f}% reduction)')

hero_source = root / 'img/lain-bg-skyline-header.png'
hero_target = root / 'img/lain-bg-skyline-header.webp'
with Image.open(hero_source) as hero:
    hero = hero.convert('RGB')
    hero.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
    hero.save(hero_target, 'WEBP', quality=86, method=6)
print(hero_target.relative_to(root))
