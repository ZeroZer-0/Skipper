# Skipper

Automatically skips intros, recaps, and next episode prompts on supported streaming sites.

## Supported Sites
If you find any site listed isnt working, please leave a review on your browser's store or open an issue on this repo.
| Site | Skip Intro | Skip Recap | Next Episode |
|------|:----------:|:----------:|:------------:|
| Netflix | ✓ | ✓ | ✓ |
| Disney+ | ✓ | ✓ | ✓ |
| Hulu | ✓ | ✓ | ✓ |
| Amazon / Prime Video | ✓ | | ✓ |
| Max | ✓ | ✓ | ✓ |
| Crunchyroll | ✓ | ✓ | ✓ |
| Paramount+ | ✓ | | ✓ |
| Peacock | ✓ | | ✓ |
| Apple TV+ | ✓ | | ✓ |
| Tubi | ✓ | | ✓ |

## Features

- Per-site and per-button enable/disable toggles
- Custom button support — add your own CSS selectors for unsupported sites
- Export/import custom button configurations as JSON
- Debug mode with live button highlighting and selector tester
- Health tracking shows when each button was last successfully clicked

## Browser Support

- **Chrome** — Manifest V3
- **Firefox** — Manifest V3

## Building

```bash
npm install

# Chrome
npm run pack:chrome

# Firefox
npm run pack:firefox
