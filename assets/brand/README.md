# Post identity assets

`post.svg` is an original, manually authored envelope with a single light cue;
`favicon.svg` uses the same silhouette with geometry fitted to a 16px grid.
Neither is traced, generated from a raster, or based on a stock icon.

## Usage

- Inline `post.svg` to inherit `currentColor`: black on light surfaces, white on
  dark surfaces. Preserve the viewBox and aspect ratio; use 16/24/32/64px squares.
- External SVG images do not inherit the surrounding HTML text color. The Post
  image defaults to black; inline it for a reversed white mark.
- The favicon has an explicit white tile and black mark, keeping it visible in
  either browser theme without media queries. Future UI can use
  `<link rel="icon" type="image/svg+xml" href="/assets/brand/favicon.svg">`.
  This backend does not serve or install these files as a web frontend.
- Standalone meaningful icons have accessible titles. With an adjacent visible
  name, use `alt=""` on images, or `aria-hidden="true"` on inline SVGs. When
  repeating meaningful inline SVGs, make their title IDs and references unique.
- Platform icons identify account platforms, never status or authorization.
  Keep a visible QQ/Matrix label. Preserve their geometry and aspect ratio;
  contain QQ in a square rather than stretching its 448×512 viewBox.
- QQ supports inline `currentColor`. Matrix defaults to black; use black on a
  white surface in either theme to retain the supplied mark unchanged.

## Platform provenance and usage

Checked 2026-10-19; these are vendored SVGs, with no icon-package dependency.

| Asset | Source and rights | Local changes |
| --- | --- | --- |
| `platforms/qq.svg` | [Font Awesome Free 7.3.1 QQ](https://github.com/FortAwesome/Font-Awesome/blob/14c65a3747d0f3b751f15831fc719236aea8729d/svgs/brands/qq.svg), © 2026 Fonticons, Inc.; SVG icons licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) under its [license](https://github.com/FortAwesome/Font-Awesome/blob/14c65a3747d0f3b751f15831fc719236aea8729d/LICENSE.txt). | Accessible title/role and whitespace only; original path, viewBox, fill and copyright/license comment retained. |
| `platforms/matrix.svg` | [Simple Icons Matrix](https://github.com/simple-icons/simple-icons/blob/c71c69e3a27e4436936b831c72643e6513b9f49b/icons/matrix.svg); [CC0-1.0 project dedication](https://github.com/simple-icons/simple-icons/blob/c71c69e3a27e4436936b831c72643e6513b9f49b/LICENSE.md). Its [metadata](https://github.com/simple-icons/simple-icons/blob/c71c69e3a27e4436936b831c72643e6513b9f49b/data/simple-icons.json) cites matrix.org and lists no separate icon license. | Whitespace only; original path, title, viewBox and default black fill retained. |

Keep this attribution and QQ's embedded notice with redistributed assets. CC BY
permits redistribution and adaptation with attribution and change disclosure;
neither it nor CC0 grants trademark rights. See also the
[Simple Icons disclaimer](https://github.com/simple-icons/simple-icons/blob/c71c69e3a27e4436936b831c72643e6513b9f49b/DISCLAIMER.md).
QQ is a Tencent platform mark, used only to identify QQ accounts, without
endorsement or affiliation. It must not become Post's product identity.

The Matrix mark is used solely for truthful platform identification under
[section 2 of the Foundation's trademark policy](https://matrix.org/legal/trademark-policy/).
Follow the [official branding guidance](https://matrix.org/branding/): retain
proportions, clear space and black/white colors. Include this attribution with
future UI use, linking Matrix to https://matrix.org/:

> The Matrix logo is a trademark of The Matrix.org Foundation. Its use does not imply endorsement or affiliation.
