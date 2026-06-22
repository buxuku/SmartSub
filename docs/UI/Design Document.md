---
name: Precision Slate
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1b1b1c'
  surface-container: '#202020'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353535'
  on-surface: '#e5e2e1'
  on-surface-variant: '#bec7d4'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#303030'
  outline: '#88919d'
  outline-variant: '#3f4852'
  surface-tint: '#98cbff'
  primary: '#98cbff'
  on-primary: '#003354'
  primary-container: '#00a3ff'
  on-primary-container: '#00375a'
  inverse-primary: '#00629d'
  secondary: '#c0c1ff'
  on-secondary: '#1000a9'
  secondary-container: '#3131c0'
  on-secondary-container: '#b0b2ff'
  tertiary: '#ffb77d'
  on-tertiary: '#4d2600'
  tertiary-container: '#eb8104'
  on-tertiary-container: '#522900'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#cfe5ff'
  primary-fixed-dim: '#98cbff'
  on-primary-fixed: '#001d33'
  on-primary-fixed-variant: '#004a77'
  secondary-fixed: '#e1e0ff'
  secondary-fixed-dim: '#c0c1ff'
  on-secondary-fixed: '#07006c'
  on-secondary-fixed-variant: '#2f2ebe'
  tertiary-fixed: '#ffdcc3'
  tertiary-fixed-dim: '#ffb77d'
  on-tertiary-fixed: '#2f1500'
  on-tertiary-fixed-variant: '#6e3900'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353535'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.4'
  body-base:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.4'
  code-timecode:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1'
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 12px
  panel-padding: 16px
  element-gap: 8px
---

## Brand & Style

The design system is engineered for high-performance creative workflows, specifically catering to video editors and subtitle specialists. The brand personality is **utilitarian, professional, and authoritative**, prioritizing functional density over decorative flair. It aims to evoke the feeling of a high-end physical editing console—reliable, tactile, and precise.

The visual style is a hybrid of **Corporate Modern** and **Tactile Minimalism**. It utilizes a deep monochromatic foundation to minimize eye strain during long editing sessions, accented by a single "active" color to draw focus to critical actions. UI elements employ subtle 1px inner strokes and "sunken" states to simulate physical hardware depths without the clutter of traditional skeuomorphism.

## Colors

The palette is anchored in a three-tier dark neutral system. The darkest shade (`#141414`) serves as the canvas, while medium charcoals define the workspace panels and interactive surfaces.

- **Primary Accents**: Use "Editing Blue" (`#00A3FF`) for high-precision tools, playback indicators, and active selection states.
- **Functional Accents**: Use "Creative Indigo" (`#6366F1`) for primary calls to action (e.g., Export, Process).
- **Feedback**: Success states use a muted cyan-green to indicate completion without creating excessive visual noise.
- **Borders**: A consistent 1px stroke of `#333333` is used to separate high-density panels, ensuring clarity in a low-contrast environment.

## Typography

The system utilizes **Inter** for its neutral character and exceptional legibility at small sizes, which is critical for a high-density editing interface.

- **Technical Data**: All timecodes, file paths, and API keys must use **JetBrains Mono**. This ensures that numerical values remain vertically aligned in lists and timelines, preventing layout shifts during scrubbing or editing.
- **Hierarchy**: Use `label-caps` for panel headers and metadata categories to create a clear structural distinction from editable content.
- **Density**: Typography scales are intentionally tight. Avoid sizes larger than 20px within internal panels to maximize screen real estate for the video preview and timeline.

## Layout & Spacing

This design system uses a **fixed-fluid hybrid layout**. The sidebar and tool panels have fixed widths to maintain muscle memory for tool placement, while the central video canvas and timeline use fluid containers to adapt to the user's monitor aspect ratio.

- **Grid**: A 12-column grid is used within the main content area, but individual panels operate on a strict 4px baseline grid.
- **Density**: Spacing is compact. Standard "comfortable" padding is replaced with "compact" 12px or 16px margins to allow for professional-grade information density.
- **Breakpoints**:
  - **Desktop (Default)**: 1280px+. Focus on multi-pane layouts.
  - **Tablet**: 768px - 1279px. Sidebar collapses to icons; primary panels stack vertically.

## Elevation & Depth

Depth is used to denote interactivity and hierarchy rather than physical height.

- **Tonal Tiers**: Background is `#141414`. Floating panels or sidebar items use `#1E1E1E`. Modals and popovers use `#2A2A2A`.
- **Sunken Effects**: Input fields, segmented controls, and inactive timeline tracks use a subtle inner shadow (`inset 0 1px 2px rgba(0,0,0,0.4)`) to create a "pressed-in" look.
- **Glassmorphism**: Use a `backdrop-filter: blur(12px)` with 80% opacity on floating menus (like right-click context menus) to provide a premium feel without losing visual context.
- **Borders**: Every panel must have a 1px solid border of `#333333`. When an element is focused, the border transitions to the primary accent color.

## Shapes

The shape language is **disciplined and sharp**. A default border-radius of `4px` (Soft) is used for almost all UI elements to provide a modern feel while maintaining the professional rigor of an industrial tool.

- **Controls**: Buttons and inputs use `rounded-sm` (4px).
- **Containers**: Inner panels and cards use `rounded-md` (8px).
- **Indicators**: Status dots and "Pill" toggles use `rounded-full` to distinguish them from structural elements.

## Components

### Buttons & Controls

- **Primary**: Indigo background (`#6366F1`), white text, subtle top-edge highlight.
- **Secondary/Tool**: Charcoal background (`#2A2A2A`), 1px border, flat appearance.
- **Segmented Control**: A "sunken" track with a raised `#333` slider for active segments, mimicking hardware toggles.

### Input Fields

- **High-Precision**: Monospace font, 1px border, 0px margin between label and input. Focused state uses a 1px "Editing Blue" glow.
- **API/URL Inputs**: Include a "copy" icon and "visibility" toggle within the field suffix for utility.

### Sidebar

- **Active State**: Use a thick 3px vertical bar on the left edge in "Editing Blue" with a subtle semi-transparent background fill (`rgba(0, 163, 255, 0.1)`).

### Cards & Panels

- **Header**: Use `label-caps` in a slightly lighter gray (`#999`) with a bottom border to separate from the content.
- **Footer**: Align primary actions to the right; secondary/destructive to the left.

### Timeline/List Items

- **Active Selection**: A thin `#00A3FF` border around the entire element.
- **Success/Sync**: A muted green icon and "Ready" label in the footer of the item.
