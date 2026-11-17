# AuraJournal Style

How AuraJournal looks and talks. Use it for every new screen and when changing an old one.

## Feel

A calm paper notebook. Warm off-white pages, dark green-gray ink, one green accent. The writing is the loudest thing on screen; everything around it stays quiet.

- Warm neutrals, never pure white or pure gray.
- Green is the only brand color. Red only for errors and deleting.
- Soft corners, not pills (circles only for avatars and dots).
- Flat cards with a hairline border. Shadow only on hover and floating things.
- No helper copy. Show the controls, don't explain them.

## Colors

| Token | Value | Use |
| --- | --- | --- |
| `--aj-bg` | `#f7f6f1` | Page background (all pages, login too) |
| `--aj-surface` | `#fffdf8` | Cards, panels, inputs |
| `--aj-line` | `#e5e8df` | Card borders, dividers |
| input border | `#d5dfd4` | Textareas, outline buttons |
| `--aj-ink` | `#24342e` | Text, headings, values |
| `--aj-muted` | `#6f7f76` | Dates, meta, captions |
| `--aj-green` | `#4f7c65` | Primary buttons |
| `--aj-green-dark` | `#356b51` | Hover, links, labels, active text |
| `--aj-soft` | `#e3ece4` | Soft panels, badges, notices, back button |
| `--aj-danger` | `#a33b32` | Errors, delete |
| focus | `#8cae91` | 2px outline, 2px offset |

Entry tones (card tops, memory art): rose `#f5e1dc`, butter `#f4eacb`, lavender `#e9e4f2`, sky `#dfe7f1`, sage `#e0ebe1`.

Calendar heatmap, empty to most: `#f8f7f1`, `#e3ece4`, `#cfe0d2`, `#b5cfba`, `#94b89c`. Selected day: inset 2px `#527d66`. Active toggle: `#dceade` bg, `#356b51` text.

Record page keeps its own scene, with a soft green glow (`rgb(223 234 220 / 55%)`), never yellow.

## Type

One family: **Be Vietnam Pro** everywhere, headings and the Record page included. Hierarchy comes from size and weight, not from mixing fonts.

| Role | Style |
| --- | --- |
| Page title | `clamp(2rem, 5vw, 3rem)`, 600, letter-spacing -0.02em |
| Section title | `clamp(1.4rem, 3.4vw, 1.8rem)`, 600 |
| Card title | ~1.2rem, 600 |
| Body | 1rem; entry text 1.05rem, line-height 1.75 |
| Meta | .8–.85rem, muted |
| Label / kicker | .72rem, 600, uppercase, letter-spacing .08em, green-dark |

## Shape

- **8px**: cards, buttons, inputs, textareas, search, selects, dialogs, notices, calendar, streak badge.
- **6px**: things inside those: paper previews, memory art, calendar days, AI badge, skeletons.
- **50%**: avatars and dots only.

## Depth

- Cards: `--aj-surface` + 1px `--aj-line` border, no shadow.
- Hover: border `#c9d6c8` and/or `0 10px 26px rgb(36 52 46 / 8%)`, cards may lift 2px.
- Dialogs: `0 20px 50px rgb(36 52 46 / 22%)`, backdrop `rgb(36 52 46 / 35%)`.

## Layout

- Content column `min(100%, 1120px)`, centered; page padding `36px 24px 80px`.
- Narrow pages (calendar) max 820px.
- Top bar: breadcrumb left (uppercase, muted), avatar right.
- Grids use `auto-fill, minmax(260px, 1fr)` with 18px gaps.
- Touch targets at least 42–44px tall.

## Buttons

| Kind | Look | Use |
| --- | --- | --- |
| Primary | green fill, white text, hover green-dark | One main action per screen |
| Outline | surface fill, ink text, line border | Secondary actions |
| Quiet | transparent, green-dark text, line border | Log out, low-key actions |
| Danger | transparent, red text, `#ecd3cf` border | Delete (opens a confirm) |
| Danger solid | red fill | The confirm button in a delete dialog |

Height 42px, padding 0 18px, .9rem, 600. Disabled: 50% opacity.

## Words

- No taglines, intros or "tap here to…" lines.
- Keep labels, errors, empty states and live status.
- Search placeholder is just "Search".
- Buttons are short verbs: Save, Edit, Delete, Record, Back, Log out.
- Errors say what to do: "Could not save. Check your connection."

## Don't

- Don't add a second brand color or a second font.
- Don't use pure white, pure black or pure gray.
- Don't round controls past 8px or make pills.
- Don't put shadows on resting cards.
- Don't use red for anything but errors and delete.
- Don't add helper text to explain a control.
