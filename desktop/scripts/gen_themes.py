#!/usr/bin/env python3
"""Writes crates/brickmotion/src/theme_catalogue.rs: the BrickMotion theme catalogue.

Each theme is given by five seed colours (panel, text, dim text, accent, and its base) and every
other token is derived from them by BrickMotion's own ladder: the surface steps, hairlines,
secondary text, axis and status colours. Original palettes are our own re-tunings; public
palettes (Nord, Solarized, Gruvbox, Catppuccin, Tokyo Night, One Dark, Dracula) use their
published MIT colours and are credited in About.
"""
import colorsys, pathlib

def hx(s):
    s = s.lstrip('#')[:6]
    return tuple(int(s[i:i+2], 16) / 255 for i in (0, 2, 4))

def to_hex(c):
    return tuple(max(0, min(255, round(v * 255))) for v in c)

def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))

def hls(c):
    return colorsys.rgb_to_hls(*c)

def shift(c, dl=0.0, ds=1.0, dh=0.0):
    h, l, s = hls(c)
    return colorsys.hls_to_rgb((h + dh / 360) % 1, max(0, min(1, l + dl)), max(0, min(1, s * ds)))

def lum(c):
    f = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = map(f, c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

def hue(c):
    return hls(c)[0] * 360

# id, name, dark?, panel, text, text_dim, accent, danger, success, warning, credit
# Originals carry our own colours; public palettes their published ones.
THEMES = [
    ("dark", "Dark", True, None),
    ("light", "Light", False, None),
    ("mono-dark", "Mono Dark", True, ("#0b0b0b", "#f4f4f4", "#a8a8a8", "#f4f4f4", "#ff5a52", "#d8d8d8", "#ffffff", None)),
    ("mono-light", "Mono Light", False, ("#f7f7f5", "#101010", "#5a5a5a", "#101010", "#c0261f", "#2a2a2a", "#101010", None)),
    ("daybreak", "Daybreak", False, ("#f5f1ea", "#1c1813", "#6b6257", "#b8501f", "#bb2f2a", "#2f7a3f", "#a3700b", None)),
    ("ember", "Ember", True, ("#16181a", "#e6e3df", "#9c9a96", "#f0855c", "#ec5b52", "#7fc58a", "#e7b44a", None)),
    ("amber-terminal", "Amber Terminal", True, ("#0d0903", "#ffc970", "#b88a45", "#ffb347", "#ff6a3d", "#d9b04f", "#ffd27a", None)),
    ("green-terminal", "Green Terminal", True, ("#050c07", "#8affad", "#4fa86a", "#5cf28a", "#ff6b5c", "#5cf28a", "#e8e070", None)),
    ("cyanotype", "Cyanotype", True, ("#0b2038", "#d9efff", "#88aecb", "#74d4f5", "#ff7f7a", "#78dcb8", "#f4cf6a", None)),
    ("arcade", "Arcade", True, ("#06060c", "#f2f2ff", "#9a9ab8", "#4ff0f0", "#ff4f7a", "#5cf05c", "#f0f04f", None)),
    ("kiln-light", "Kiln Light", False, ("#f3ede3", "#1d1915", "#6e6559", "#b04f2f", "#b5302b", "#3d7a43", "#a06d12", None)),
    ("kiln-dark", "Kiln Dark", True, ("#1f1b17", "#e9e3db", "#a39889", "#e07c57", "#e85e53", "#8cc68f", "#e3b25a", None)),
    ("studio-light", "Studio Light", False, ("#f2f2f3", "#1b1b1d", "#68686e", "#1d6fe0", "#d93a32", "#2f9a4c", "#c58a10", None)),
    ("slate", "Slate", True, ("#202326", "#e3e5e8", "#9aa0a8", "#55a7d6", "#e0605a", "#86c49c", "#e2b85a", None)),
    ("high-contrast", "High Contrast", True, ("#000000", "#ffffff", "#d0d0d0", "#29c4ff", "#ff5a5a", "#4ce38a", "#ffd23f", None)),
    ("basalt", "Basalt", True, ("#1e2022", "#dcdddb", "#9a9e9f", "#a3b3c0", "#d77b74", "#a7bba5", "#d8bb7c", None)),
    ("classic", "Classic", False, ("#dedede", "#111111", "#555555", "#4b4b94", "#a52828", "#3f7f3f", "#8a6a10", None)),
    ("retro-grey", "Retro Grey", False, ("#c9c9c9", "#000000", "#3f3f3f", "#14148c", "#9c1010", "#0f6e0f", "#7d6400", None)),
    # Public palettes: their own published colours, our mapping.
    ("nord", "Nord", True, ("#2e3440", "#eceff4", "#a3abb9", "#88c0d0", "#bf616a", "#a3be8c", "#ebcb8b", "Nord palette by Arctic Ice Studio (MIT)")),
    ("solarized-dark", "Solarized Dark", True, ("#002b36", "#eee8d5", "#93a1a1", "#268bd2", "#dc322f", "#859900", "#b58900", "Solarized palette by Ethan Schoonover (MIT)")),
    ("solarized-light", "Solarized Light", False, ("#fdf6e3", "#073642", "#657b83", "#268bd2", "#dc322f", "#859900", "#b58900", "Solarized palette by Ethan Schoonover (MIT)")),
    ("gruvbox-dark", "Gruvbox Dark", True, ("#282828", "#ebdbb2", "#a89984", "#83a598", "#fb4934", "#b8bb26", "#fabd2f", "Gruvbox palette by Pavel Pertsev (MIT)")),
    ("gruvbox-light", "Gruvbox Light", False, ("#fbf1c7", "#3c3836", "#7c6f64", "#076678", "#9d0006", "#79740e", "#b57614", "Gruvbox palette by Pavel Pertsev (MIT)")),
    ("catppuccin-mocha", "Catppuccin Mocha", True, ("#1e1e2e", "#cdd6f4", "#a6adc8", "#cba6f7", "#f38ba8", "#a6e3a1", "#f9e2af", "Catppuccin palette (MIT)")),
    ("tokyo-night", "Tokyo Night", True, ("#1a1b26", "#c0caf5", "#9aa5ce", "#7aa2f7", "#f7768e", "#9ece6a", "#e0af68", "Tokyo Night palette by enkia (MIT)")),
    ("one-dark", "One Dark", True, ("#282c34", "#dcdfe4", "#9da5b4", "#61afef", "#e06c75", "#98c379", "#e5c07b", "Atom One Dark palette (MIT)")),
    ("nightshade", "Nightshade", True, ("#282a36", "#f8f8f2", "#a8abc4", "#bd93f9", "#ff5555", "#50fa7b", "#f1fa8c", "Colours from the Dracula palette (MIT)")),
]

ORANGE_DARK, ORANGE_LIGHT = hx("#ff9f43"), hx("#e07b12")

def derive(dark, seeds):
    panel, text, dim, accent, danger, success, warning, credit = seeds
    panel, text, dim, accent, danger, success, warning = map(hx, (panel, text, dim, accent, danger, success, warning))
    if dark:
        bg0 = shift(panel, -0.025)
        bg1 = panel
        bg2 = shift(panel, 0.022)
        bg3 = shift(panel, 0.050)
        border = mix(bg1, text, 0.11)
        border2 = mix(bg1, text, 0.16)
        playhead = ORANGE_DARK
    else:
        bg0 = shift(panel, -0.030)
        bg1 = panel
        bg2 = shift(panel, 0.040)
        bg3 = shift(panel, -0.018)
        border = mix(bg1, text, 0.11)
        border2 = mix(bg1, text, 0.17)
        playhead = ORANGE_LIGHT
    text2 = dim
    text3 = mix(dim, bg1, 0.38)
    # The playhead stays the only orange: on themes whose accent is already orange-red or
    # amber it turns to the text colour, which still stands out over every lane.
    if 10 <= hue(accent) <= 50 and hls(accent)[2] > 0.35:
        playhead = text
    on_accent = (0, 0, 0) if contrast(accent, (0, 0, 0)) >= contrast(accent, (1, 1, 1)) else (1, 1, 1)
    on_playhead = (0, 0, 0) if contrast(playhead, (0, 0, 0)) >= contrast(playhead, (1, 1, 1)) else (1, 1, 1)
    on_playhead = mix(on_playhead, playhead, 0.1)
    blue = accent if 190 <= hue(accent) <= 260 and hls(accent)[2] > 0.0 and hls(accent)[2] < 1 and hls(accent)[1] > 0.25 else (hx("#4f8cff") if dark else hx("#2f6fe4"))
    if hls(accent)[2] < 0.1:  # a grey accent: keep axis hues readable
        blue = hx("#6b9cff") if dark else hx("#2f6fe4")
    key = mix(text2, text, 0.45)
    camera_key = mix(warning, bg1, 0.12)
    return dict(bg0=bg0, bg1=bg1, bg2=bg2, bg3=bg3, border=border, border2=border2, text1=text, text2=text2,
                text3=text3, accent=accent, playhead=playhead, danger=danger, success=success, warning=warning,
                on_accent=on_accent, axis=[danger, success, blue], on_playhead=on_playhead, knob=(1, 1, 1),
                key=key, camera_key=camera_key, dark=dark), credit

def c32(c):
    r, g, b = to_hex(c)
    return f"Color32::from_rgb(0x{r:02x}, 0x{g:02x}, 0x{b:02x})"

out = ["// @generated by desktop/scripts/gen_themes.py; edit the seeds there, not this file.",
       "use egui::Color32;", "", "use crate::theme::{Theme, ThemeDef};", "",
       "pub const CATALOGUE: &[ThemeDef] = &["]
for tid, name, dark, seeds in THEMES:
    if seeds is None:
        out.append(f'    ThemeDef {{ id: "{tid}", name: "{name}", theme: Theme::{"DARK" if dark else "LIGHT"}, credit: None }},')
        continue
    d, credit = derive(dark, seeds)
    fields = []
    for k in ["bg0", "bg1", "bg2", "bg3", "border", "border2", "text1", "text2", "text3", "accent", "playhead",
              "danger", "success", "warning", "on_accent"]:
        fields.append(f"{k}: {c32(d[k])}")
    fields.append("axis: [" + ", ".join(c32(a) for a in d["axis"]) + "]")
    for k in ["on_playhead", "knob", "key", "camera_key"]:
        fields.append(f"{k}: {c32(d[k])}")
    fields += ["radius: 6.0", "grid: 8.0", f"dark: {'true' if dark else 'false'}"]
    cr = f'Some("{credit}")' if credit else "None"
    body = ",\n            ".join(fields)
    out.append(f'    ThemeDef {{\n        id: "{tid}",\n        name: "{name}",\n        theme: Theme {{\n            {body},\n        }},\n        credit: {cr},\n    }},')
    # Contrast report for the generator's own check.
    for fg, bg, need in [("text1", "bg1", 7.0), ("text2", "bg1", 3.0), ("on_accent", "accent", 3.0)]:
        cr_ = contrast(d[fg], d[bg])
        if cr_ < need:
            print(f"warn {tid}: {fg} on {bg} contrast {cr_:.2f} < {need}")
out.append("];")
dst = pathlib.Path(__file__).resolve().parent.parent / "crates/brickmotion/src/theme_catalogue.rs"
dst.write_text("\n".join(out) + "\n")
print("wrote", dst, len(THEMES), "themes")
