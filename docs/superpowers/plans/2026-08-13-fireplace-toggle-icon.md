# Fireplace Toggle Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Homey's generic power glyph for Fireplace controls with a clear fireplace-outline icon on both the Web toggle and device-tile quick action.

**Architecture:** Add one monochrome SVG under the app's global assets and reference it from the existing `vasco_fireplace` custom capability. Explicitly enable `uiQuickAction`; do not change runtime control behavior, the driver icon, or the numeric mode indicator.

**Tech Stack:** SVG 1.1-safe markup, Homey Compose, Node.js 22 `node:test`, official Homey CLI.

## Global Constraints

- The icon depicts a classic fireplace surround with a small flame, not a generic flame alone.
- Use a transparent 960×960 viewBox, black monochrome strokes, rounded joins/caps, and no scripts, external references, embedded raster images, gradients, or text.
- Set `icon` to `/assets/vasco_fireplace.svg` and `uiQuickAction` to `true` on `vasco_fireplace`.
- Preserve `uiIndicator: measure_vasco_mode`, the ventilation-unit device icon, all toggle behavior, translations, and Flow cards.
- Do not expose credentials, tokens, identifiers, or capture artifacts.

---

### Task 1: Add and publish the Fireplace capability icon

**Files:**
- Create: `assets/vasco_fireplace.svg`
- Modify: `.homeycompose/capabilities/vasco_fireplace.json`
- Modify: `test/unit/homey-manifest.test.js`
- Modify: `test/unit/publish-assets.test.js`
- Regenerate: `app.json`

**Interfaces:**
- Produces: capability properties `icon: "/assets/vasco_fireplace.svg"` and `uiQuickAction: true`.
- Produces: a safe standalone SVG rendered by Homey as a theme-controlled mask.

- [ ] **Step 1: Write failing metadata and asset tests**

Add to `test/unit/homey-manifest.test.js`:

```js
assert.equal(fireplace.icon, '/assets/vasco_fireplace.svg');
assert.equal(fireplace.uiQuickAction, true);
```

Add to `test/unit/publish-assets.test.js`:

```js
test('Fireplace capability icon is safe monochrome fireplace artwork', () => {
  const icon = read('assets', 'vasco_fireplace.svg');
  assert.match(icon, /viewBox="0 0 960 960"/);
  assert.match(icon, /id="fireplace-surround"/);
  assert.match(icon, /id="hearth-flame"/);
  assert.doesNotMatch(icon, /<script|<image|href=|url\(|<text|linearGradient|radialGradient/i);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='setable custom toggle|Fireplace capability icon' test/unit/homey-manifest.test.js test/unit/publish-assets.test.js`

Expected: FAIL because the capability has no icon/quick-action declaration and the SVG does not exist.

- [ ] **Step 3: Create the SVG**

Create `assets/vasco_fireplace.svg` with this exact safe structure:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960" role="img" aria-label="Fireplace">
  <g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
    <g id="fireplace-surround" stroke-width="64">
      <path d="M130 270h700M185 270v560M775 270v560M120 830h720"/>
      <path d="M300 830V430h360v400"/>
    </g>
    <g id="hearth-flame" stroke-width="58">
      <path d="M480 725c-92 0-148-55-148-137 0-67 40-113 92-166 3 67 34 87 56 120 25-43 49-76 45-132 70 61 103 111 103 178 0 82-56 137-148 137Z"/>
      <path d="M480 710c-39 0-65-26-65-64 0-30 18-53 48-83 2 31 17 43 27 58 13-22 25-39 23-68 32 29 48 56 48 93 0 38-30 64-81 64Z"/>
    </g>
  </g>
</svg>
```

- [ ] **Step 4: Reference the icon and quick action**

Add to `.homeycompose/capabilities/vasco_fireplace.json`:

```json
"uiQuickAction": true,
"icon": "/assets/vasco_fireplace.svg"
```

- [ ] **Step 5: Run focused tests and inspect rendered SVG**

Run: `node --test test/unit/homey-manifest.test.js test/unit/publish-assets.test.js`

Render the SVG to PNG with an available SVG renderer and inspect it at full size and approximately 48×48. Confirm the fireplace surround and inner flame remain distinct and centered.

- [ ] **Step 6: Regenerate and validate Homey manifests**

Run: `npx homey app build`

Run: `npx homey app validate --level=debug`

Run: `npx homey app validate --level=publish`

Expected: generated `app.json` includes the icon path and quick-action flag; all commands exit zero.

- [ ] **Step 7: Run complete verification**

Run: `npm test`

If Aikido MCP is unavailable, report it and run:

```bash
node --test test/secret-safety.test.js
git diff --check
```

Expected: all tests and fallback checks pass.

- [ ] **Step 8: Commit**

```bash
git add assets/vasco_fireplace.svg .homeycompose/capabilities/vasco_fireplace.json test/unit/homey-manifest.test.js test/unit/publish-assets.test.js app.json
git commit -m "feat: add Fireplace toggle icon"
```

- [ ] **Step 9: Install and visually verify**

Confirm `homey select current` reports `Homey Pro (66ed660f9d397dcbcfe1ac46)`, then run `npx homey app install`. Verify device `2dc8f187-d214-4d5b-8dc4-d3aa005375fc` remains available with `uiIndicator: measure_vasco_mode` and `quickActionOverride: vasco_fireplace`. Ask the user to confirm the fireplace outline appears on Homey Web's large toggle and tile quick action.
