# Third-party notices

Assets, fonts and libraries added by the design system (`packages/ui`) and the
mobile icon layer. Per-file provenance of every image: `packages/ui/assets/ASSETS.md`.
Licence texts of npm packages ship in each package under `node_modules/<name>/LICENSE`;
the notices required by those licences are reproduced or referenced below.

## Bundled in the apps

| Component | Version | Licence | Source |
|---|---|---|---|
| Lucide icons — `lucide-react` (web/desktop) | ^1.74.0 | ISC | https://lucide.dev · https://github.com/lucide-icons/lucide |
| Lucide icons — `lucide-react-native` (mobile) | ^1.74.0 | ISC | https://github.com/lucide-icons/lucide |
| `react-native-svg` (renders Lucide on mobile) | 15.8.0 | MIT | https://github.com/software-mansion/react-native-svg |
| Barlow Semi Condensed font via `@fontsource/barlow-semi-condensed` (self-hosted) | ^5.3.0 | SIL Open Font License 1.1 (font); MIT (Fontsource packaging) | https://github.com/jpt/barlow · https://fontsource.org |
| Radix UI primitives (`@radix-ui/react-*`, pre-existing) | see package.json | MIT | https://github.com/radix-ui/primitives |

ISC notice (Lucide): "Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022
as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
2022." Permission to use, copy, modify, and/or distribute this software for any purpose with
or without fee is hereby granted, provided that the above copyright notice and this permission
notice appear in all copies. The full text is in `node_modules/lucide-react/LICENSE`.

SIL OFL 1.1 (Barlow): the font may be bundled and redistributed with the app; it may not be
sold by itself, and Reserved Font Names may not be used for modified versions. Full text:
`node_modules/@fontsource/barlow-semi-condensed/LICENSE`.

## Generated illustrations and motion (`packages/ui/assets/`)

Generated for this project; no third-party artwork is embedded. The generation tools'
licences do not restrict use of their outputs, and none of the images contains text,
letters, logos or brand marks.

| Tool | Licence | Source |
|---|---|---|
| Qwen-Image (illustrations) | Apache-2.0 | https://huggingface.co/Qwen/Qwen-Image |
| Qwen-Image-Edit 2511 (mascot expressions, edited from the ghost master) | Apache-2.0 | https://huggingface.co/Qwen/Qwen-Image-Edit-2511 |
| Wan 2.2 TI2V-5B (motion) | Apache-2.0 | https://github.com/Wan-Video/Wan2.2 |
| Real-ESRGAN x4plus (upscaling) | BSD-3-Clause | https://github.com/xinntao/Real-ESRGAN |
| BiRefNet (background removal) | MIT | https://github.com/ZhengPeng7/BiRefNet |
| ComfyUI (pipeline) | GPL-3.0 (tool only; nothing from it ships) | https://github.com/comfyanonymous/ComfyUI |

## Development only (not shipped)

| Component | Licence |
|---|---|
| `@axe-core/playwright` (accessibility check against the built web app) | MPL-2.0 |

Microsoft Fluent Emoji 3D (MIT) were used as temporary placeholders during development and
have been removed; none ship.
