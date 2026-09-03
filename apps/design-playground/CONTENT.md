# Canonical page content

Every design page renders exactly this content, in this order. The design system around it is
the only variable. Copy is verbatim — do not paraphrase it, and do not add or drop sections.

## 1. Back chip

A small fixed-position link in a corner: `← All designs`, pointing to `../`.

## 2. Navigation

- Wordmark: **Grove**
- Links: **Play**, **Create**, **Community**
- Call-to-action button: **Join Grove**

## 3. Hero

- Eyebrow: `A place to grow`
- Headline: `Grow your world.`
- Subline: `Build games with friends, explore worlds made by kids like you, and watch your
wildest ideas take root.`
- Primary button: `Start playing`
- Secondary button: `Make a game`
- A hero visual in the page's own aesthetic (inline SVG or styled shapes — no external images).

## 4. Featured worlds

Section heading: `Featured worlds` with subline `Fresh from the community garden.`

Three world cards, each with a visual, title, creator, live player count, a genre tag, and a
play action:

| Title        | Creator | Playing now | Tag       |
| ------------ | ------- | ----------- | --------- |
| Mossy Hollow | by Pip  | 128 playing | Adventure |
| Cloud Bakery | by Luna | 86 playing  | Cozy      |
| Robo Garden  | by Max  | 214 playing | Builder   |

## 5. Bits & pieces (component specimen)

Section heading: `Bits & pieces`

- Buttons: primary `Plant it`, secondary `Maybe later`, disabled `Locked`
- Text input: label `Pick a nickname`, placeholder `mossy_pip`
- Toggle: label `Garden sounds`, switched on
- Badges: `New sprout`, `Level 12`, `Friends only`
- Progress: label `Garden level 7`, filled to 64%

## 6. Type & tone (typography specimen)

Section heading: `Type & tone`

- Display: `Big dreams grow here`
- Heading: `Every garden starts with a seed`
- Body: `Grove is a cozy corner of the internet where kids build, share, and play together.
Plant an idea, water it with friends, and watch what grows.`
- Caption: `Made for ages 8 and up. Grown-ups welcome too.`

## 7. Palette

Section heading: `Palette`

Five or six labeled swatches showing this design's core colors, each with a friendly name and
its hex value. (Values differ per design; the section itself is required.)

## 8. Footer

- `Grove — made with care for curious kids.`
- Links: **Safety**, **For grown-ups**, **Help**
- Credit line: `Design direction: <Name>`

# Rules every page follows

- One self-contained file at `src/pages/<slug>.html`: inline `<style>` and `<script>`, no
  external assets. Exception: Google Fonts `<link>` tags are allowed, always with a sensible
  `font-family` fallback stack.
- `<title>Grove · <Design name></title>` and a `<meta name="viewport">` tag.
- The design must speak through all five channels: component construction, color, typography,
  spacing/layout, and motion.
- Motion is mandatory: an entrance animation, at least one looping ambient detail, and
  hover/press states on every interactive element — all inside
  `@media (prefers-reduced-motion: no-preference)` or neutralized by a `reduce` override.
- Responsive from 360px to 1440px with no horizontal scroll.
- Semantic HTML with basic accessibility: real `<button>`/`<a>`/`<label>` elements, labelled
  form controls, readable contrast within the aesthetic's spirit.
- Warm, kid-appropriate, and safe. No irony, no edge, no dark patterns.
- CSS does the animating; JavaScript only for tiny interactions (the toggle, small delights).
