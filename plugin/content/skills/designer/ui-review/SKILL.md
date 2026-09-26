---
name: ui-review
description: The twelve checks a screen is read with, what each can judge from a picture, and the shape a finding takes. Open it when reviewing a user interface.
---

# UI review — twelve checks

Run them in order. Each check names its channel: **[eye]** judge from the image alone, in relatives; **[eye+tokens]** suspect from the image, confirm the exact value in the tokens or CSS; **[code]** beyond a still picture — say it was not checkable and move on.

- **R1 Spacing rhythm** [eye] — gaps fall on a small consistent scale (4/8/16/24/32), with more space between groups than inside them. Uneven or arbitrary gaps are a finding.
- **R2 Hierarchy** [eye] — exactly one visually dominant element or action per screen, the rest clearly de-emphasized. Everything shouting equally is a finding.
- **R3 Type scale and Vietnamese line height** [eye; values eye+tokens] — few sizes in a clear scale; body lines breathe (Vietnamese needs more leading than Latin — stacked marks like ế ộ ằ collide when lines are tight). Clipped or colliding diacritics are always a finding.
- **R4 Color roles and contrast** [eye; ratios code] — colors map to meaning (primary, danger, success, muted), no stray hues; obviously faint text is a finding; the exact ratio is never yours to state.
- **R5 Dense tables** [eye] — even row heights, right-aligned numbers, long text truncates gracefully, the eye can scan a row without losing its place.
- **R6 Controls** [eye] — one filled primary action per view; destructive actions look destructive; secondary controls visibly subordinate; everything pressable looks pressable.
- **R7 Empty, loading and error states** [eye when visible; often code] — no blank regions; skeletons over spinners for tables; errors offer a way out. A state you cannot see in a still picture is not a finding — name it as not checkable.
- **R8 Alignment** [eye] — one left grid, matching widths, labels and inputs aligned; nothing drifting one or two pixels off its neighbors.
- **R9 Consistency against the references** [eye] — the anchor check: the same class of screen uses the same header, action and table language as the approved references. Drift is a finding even when each piece alone looks fine.
- **R10 Vietnamese rendering** [eye] — no tofu, no mixed fallback fonts, no clipped marks in buttons, badges or inputs; Vietnamese and English not mixed inside one component; đ and thousand separators in the Vietnamese convention.
- **R11 Overflow** [eye] — nothing colliding, wrapping badly, cut off or scrolling sideways; Vietnamese runs long, and a truncated label that loses its meaning is a finding.
- **R12 Glanceability** [eye] — for a point of sale: the total, the quantity and the pay action findable in two seconds; the eye path from top-left to bottom-right unobstructed.

# How to look

- Describe, then judge. The inventory of what is on the screen comes before any verdict about it.
- Relative measures only: "about twice", "visibly smaller", "the same as the reference". Never px, pt, rem or hex from your eyes.
- Two images beat one: when references are given, name the differences in pattern — not a score, not a percentage.
- Dense screens: describe region by region (the table, the header, the form) rather than everything at once.

# The shape of a finding

```
severity: P0 | P1 | P2 | P3
where:    the region, plus the exact words quoted from the screen
failure:  the check it fails, and what the eye sees
fix:      concrete, token-named or relative — never an invented number
```

P0 unreadable or broken (illegible text, contrast failure on the totals, a missing state on a core flow). P1 ugly and systemic (hierarchy, rhythm, drift from the references). P2 one local slip. P3 polish.

The three findings with the highest impact on the whole screen come before all others.
