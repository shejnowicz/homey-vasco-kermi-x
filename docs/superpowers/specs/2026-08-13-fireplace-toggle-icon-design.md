# Fireplace Toggle Icon Design

## Goal

Make the Fireplace toggle self-explanatory in Homey Web, where Homey renders a
large icon-only control and does not show the custom capability title.

## Visual design

Replace the generic power symbol with a monochrome outline of a classic
fireplace. The icon contains:

- a simple mantel and rectangular fireplace surround;
- an open hearth inside the surround;
- one small, recognizable flame inside the hearth.

The artwork uses thick, rounded strokes and no text, gradients, fills that merge
into the background, or fine decorative details. It remains recognizable at the
small sizes used by the mobile app and as the large white control in Homey Web.

## Integration

Create a dedicated SVG asset for the existing custom `vasco_fireplace`
capability and reference it from the capability's Homey Compose definition. Do
not change the capability ID, toggle behavior, translations, device tile
indicator, or Flow cards.

The SVG follows the same monochrome, transparent-canvas conventions as the
app's existing Homey assets. Homey controls its rendered color according to the
current theme and control state.

## Verification

Automated checks verify that the capability references an existing valid SVG,
the SVG contains only safe vector markup, and generated `app.json` includes the
icon reference. Homey debug and publish validation must pass.

Physical UI verification confirms that Homey Web shows the fireplace outline
instead of the generic power icon and that the mobile control remains readable
with its existing label.
