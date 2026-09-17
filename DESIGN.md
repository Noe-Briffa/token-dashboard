# Design System

## Visual Theme

Mineral light: une surface claire légèrement chaude, de l'encre graphite et
des accents de données sobres. Le thème est conçu pour une consultation
prolongée dans un bureau éclairé, avec assez de contraste pour les chiffres et
les tableaux.

## Color Palette

- `--bg`: `oklch(96% 0.012 95)`, surface générale ivoire minérale.
- `--surface`: `oklch(99% 0.006 95)`, surface principale.
- `--surface-muted`: `oklch(93% 0.012 95)`, barres d'outils et zones secondaires.
- `--ink`: `oklch(24% 0.018 255)`, texte principal graphite bleuté.
- `--ink-muted`: `oklch(52% 0.025 255)`, texte secondaire.
- `--line`: `oklch(86% 0.018 95)`, séparateurs discrets.
- `--accent`: `oklch(61% 0.145 164)`, action et sélection menthe.
- `--accent-soft`: `oklch(91% 0.055 164)`, fonds d'état accentué.
- Data colors use deliberate mint, violet, amber, blue and coral roles.

## Theme Variants

The default preference is `system`. Users can explicitly choose `light` or
`dark`; an explicit choice is persisted locally. The dark variant uses mineral
night surfaces rather than pure black: `--bg` at approximately 17% lightness,
panels at 22%, graphite-tinted borders, warm light text and a slightly
desaturated mint accent. Data colors keep their meaning and are adjusted only
for contrast against the active surface.

## Typography

Use `Inter`, `ui-sans-serif`, `system-ui`, sans-serif. Use a compact fixed
scale for product UI: 11px metadata, 12px labels, 14px body, 16px section
titles, 30px page title. Numbers use `font-variant-numeric: tabular-nums`.

## Layout

Use a centered max-width of 1360px with 24px desktop gutters and 16px mobile
gutters. Establish hierarchy through whitespace: toolbar, summary strip,
primary chart, secondary analysis, then details. Avoid nested cards where a
section boundary or table header is sufficient.

## Components

- Buttons: 8px radius, solid accent for primary action, outlined secondary.
- Controls: 8px radius, minimum 36px height, visible focus ring.
- Panels: 14px radius, 1px line, low-contrast surface, no decorative shadow.
- Metrics: compact editorial cells with label, value and contextual note.
- Charts: strong axis contrast, visible empty state, labels only where useful.
- Tables: sticky-feeling headers through contrast, restrained row separators.

## Motion

Use 150ms to 220ms ease-out transitions for controls and state changes only.
Disable non-essential transitions under `prefers-reduced-motion`.
