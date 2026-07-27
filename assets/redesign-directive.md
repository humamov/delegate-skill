# REDESIGN directive (user-named workflow: "redesign")

When the user says "redesign <page>" (or invokes the redesign workflow), the target page is rebuilt
to THIS exact design language — the one locked in on the dealer-profile pages of Cashier_V2 web
(reference implementation: `web/src/app/(app)/dealers/[id]/page.tsx` + the sibling
`web/src/app/(app)/dealers/_components/dealer-overview-tab.tsx` — NOT nested under `[id]/`).
Paste this whole file into the executor brief.

## The rules
1. **Full bleed.** The page fills the full width and 100% height of the layout viewport. Zero outer
   margins, zero page padding, no max-width container. White surface (token.colorBgContainer)
   edge-to-edge and down to the viewport bottom — the layout's grey background must never be visible
   (no grey band below short content: root container flex column + minHeight fills the viewport).
2. **Grid by borders, not gaps.** No gap/gutter between cards or sections — components sit adjacent,
   separated ONLY by 1px hairline borders in a LIGHT tone (token.colorSplit / colorBorderSecondary).
   It reads as one continuous surface ruled into a grid. No Row/Col `gutter` for card spacing; use
   dividing borders (borderInlineEnd / borderBlockEnd on grid cells — logical props only).
3. **Flat everything.** Cards `variant="borderless"` + borderRadius 0, no boxShadow anywhere, no
   grey header fills; antd Card head borders off. Section headings use the shared `SectionTitle`
   component (rule 11), sentence case — never ALL-CAPS bands.
4. **Card padding: double start.** Inside each card/cell: paddingInlineStart 32 (double the 16 theme
   base) — and mirror paddingInlineEnd 32 so both edges breathe (established page standard);
   comfortable block padding (~24), paddingBlockEnd 32+ on the page's last section.
5. **Tables in this language:** scoped ConfigProvider Table tokens — borderColor 'transparent'
   (no row lines), headerBg 'transparent', fontSize 13 for embedded/secondary tables; columns all
   start-aligned; dates via the shared format-date lib (YYYY-MM-DD HH:mm:ss).
6. **Icon tiles:** 44×44 (40 in dense grids), borderRadius 10, background token.colorFillTertiary,
   lucide icon 20 — icon stroke may carry an accent color, the TILE background stays neutral.
7. **Pills over ink bars:** tab/range switchers are text items where the ACTIVE one sits on a soft
   grey pill (token.colorFillTertiary, radius 8, semibold) — no underlines, no outlined boxes,
   no focus halo persisting after mouse click.
8. **Theme-safe + RTL-safe:** tokens over hexes, logical props only (paddingInline*, borderInlineEnd),
   verified in dark mode and at ~390px mobile width — the grid borders collapse to stacked rows with
   borderBlockEnd separators on narrow screens.
9. **Pure antd:** inline style props + theme tokens only. NO className, NO <style>, no CSS files,
   no new dependencies.
10. **Standard pagination** (web/src/lib/pagination.ts STANDARD_PAGINATION) wherever a table paginates.
11. **One title style everywhere.** Every page and section heading uses the SAME component — the
    "Activity overview" pattern the user locked: `Typography.Title level={5}` (16px, semibold,
    margin 0) with an optional `Typography.Text type="secondary"` description line beneath (13–14px).
    Use a shared `SectionTitle` component (`web/src/components/section-title.tsx`, plus a portal
    twin) — it does not exist yet as of 27-jul-2026 (the dealer-overview-tab.tsx reference above
    still inlines `Typography.Title` directly), so create it first from the exact spec above, in
    whichever app doesn't have it yet, then use it — never a page-local h2/h3 or bespoke strong
    text. Field labels inside stat tiles/forms are NOT titles and keep their own (secondary
    12–13px) treatment.

## Executor gates (unchanged)
cd <app> && npx tsc --noEmit && npm run lint — plus a real browser pass: desktop + ~390px, light +
dark, checking specifically: no grey visible anywhere, hairline grid reads, both card edges padded 32,
no shadows, cards/sections flat (radius 0 per rule 3 — icon tiles keep radius 10 and pills keep
radius 8, rules 6–7).
