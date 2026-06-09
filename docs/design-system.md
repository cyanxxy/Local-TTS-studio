# Design System

Open TTS uses a Liquid Glass direction: translucent blurred surfaces, specular edges, and soft depth over an ambient color field. The implementation is token-first and lives in `src/index.css`; components should reuse the existing `.glass*` utilities and Tailwind token utilities instead of inventing new visual effects.

| Token | Value |
|---|---|
| `font-sans` | Inter Variable, self-hosted |
| `font-display` | Outfit Variable, self-hosted |
| `font-mono` | JetBrains Mono Variable, self-hosted |
| `--color-surface` | `#F5F5F7` |
| `--color-panel` | `#FFFFFF` |
| `--color-accent` | `#0071E3` |
| `--color-text-primary` | `#1D1D1F` |
| Glass utilities | `.glass`, `.glass-panel`, `.glass-pop`, `.glass-accent`, `.glass-inset` |
| Shadows | `--shadow-xs/sm/md/lg`, `--shadow-accent-sm/md/lg`, `--shadow-glass-sm/md/lg` |
| Icon sizes | `xs=12px`, `sm=14px`, `md=16px` |

The `.glass*` utilities are intentionally unlayered so they win over Tailwind utilities. Use them on static containers and build interactive states from explicit utilities such as `bg-white/40`, `border-white/55`, `backdrop-blur-md`, and `shadow-glass-sm`. Electron on macOS also relies on transparent window vibrancy plus the `is-electron` / `is-mac` HTML classes, so keep that CSS scoping intact.
