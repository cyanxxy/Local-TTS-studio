# Design System

Open TTS aims for a flat, minimal, OS-native feel: typography-forward, restrained, and built on tokens rather than ad hoc component styling.

| Token | Value |
|---|---|
| `font-sans` | Inter Variable, self-hosted |
| `font-display` | Outfit Variable, self-hosted |
| `font-mono` | JetBrains Mono Variable, self-hosted |
| `--color-surface` | `#F5F5F7` |
| `--color-panel` | `#FFFFFF` |
| `--color-accent` | `#0071E3` |
| `--color-text-primary` | `#1D1D1F` |
| Shadows | `--shadow-xs/sm/md/lg`, `--shadow-accent-sm/md/lg` |
| Icon sizes | `xs=12px`, `sm=14px`, `md=16px` |

All colors and effects flow through `@theme` variables in `src/index.css`. Components should use tokens or `color-mix()` rather than hardcoded hex values.
