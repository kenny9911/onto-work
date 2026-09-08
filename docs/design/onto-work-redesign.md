# onto-work frontend redesign

This is the current visual direction, requested on 9 September 2026. It replaces the earlier graphite, lime and violet operations-console design. Existing behavior, access controls and API boundaries still apply.

## References and design process

- [Grok](https://grok.com): a focused opening question, generous composer, minimal chrome and quiet secondary controls.
- [Claude Cowork](https://claude.com/product/cowork): a calm workspace, warm neutral surfaces and a readable narrative of work.
- [Claude Design prototype](https://claude.ai/design/p/c75d6a94-c6ee-4a69-a118-a6473e988267?file=onto-work+redesign.dc.html): a new navigable direction developed in the existing project. Earlier design files remain available as references.

The production React implementation uses real application state. Fictional prototype records are not imported into the application.

## Visual system

The default theme uses paper (#faf9f6), stone (#f0efeb), white content surfaces and charcoal actions. Clay accents highlight a human decision. The dark theme uses warm charcoal surfaces with cream text and actions. Green, amber and red communicate execution, waiting and failure; color always accompanies text or an icon.

`apps/web/src/styles.css` defines primitive colors, semantic roles and shared component aliases. The theme is persisted locally and can be changed in the header.

| Role | Typeface | Size / line height |
| --- | --- | --- |
| Metadata | Open Sans | 12 / 18px |
| Controls and navigation | Open Sans | 14 / 20px |
| Prose | Open Sans | 16 / 26px |
| Section title | Open Sans | 20 / 28px |
| Page title | Open Sans | 28 / 36px |
| Code, paths and identifiers | JetBrains Mono | 13 / 20px |

Source Han Sans CN supplies Chinese glyphs. Fonts are served locally. Ordinary labels do not use monospace or widely spaced uppercase text. The typography contract checks both arbitrary component sizes and semantic metadata sizes against the 12px floor.

## Layout and interaction

- The 56px header and 256px sidebar establish a consistent frame. Sidebar navigation uses icons and readable rows; task history and account controls have their own clear places.
- A new task opens around a focused question, project-aware composer and prompt suggestions. Execution detail appears when there is actual work to show.
- Active tasks retain a readable conversation and visible approvals. Tools, details and the inspector supplement the conversation.
- Management pages share heading/action rows, bounded content widths, summary strips, readable lists and settings sections.
- Inputs, buttons, tabs, menus and dialogs use common typography, surfaces, focus rings and corner radii.
- On narrow screens, navigation and inspection use drawers. Content scrolls within the app, tables can scroll horizontally, and dialogs remain within the viewport.
- Unsupported actions remain explicit. Labels describe what a control does; sign out is never disguised as capacity information. Permission information reflects server-managed policy.

## Behavior boundaries

The redesign retains session handling, task lifecycle, uploads, live event isolation, approval decisions, saved-project authorization, role-sensitive navigation and server-owned model selection. It adds no execution policy or authentication bypass. Existing tests exercise these behaviors; browser checks cover desktop/mobile presentation, navigation, theme switching and the composer.
