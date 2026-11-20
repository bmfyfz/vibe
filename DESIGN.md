---
name: Vibe
description: Channels, threads and tasks for people and coding agents, drawn as a bay of flight progress strips.
colors:
  bay: "oklch(0.948 0.007 252)"
  paper: "oklch(0.994 0.002 252)"
  paper-2: "oklch(0.972 0.005 252)"
  rule: "oklch(0.885 0.009 252)"
  rule-2: "oklch(0.79 0.012 252)"
  ink: "oklch(0.225 0.022 258)"
  ink-2: "oklch(0.4 0.022 258)"
  ink-3: "oklch(0.52 0.018 258)"
  rail: "oklch(0.275 0.032 258)"
  rail-2: "oklch(0.335 0.038 258)"
  rail-3: "oklch(0.4 0.045 258)"
  rail-ink: "oklch(0.955 0.008 252)"
  rail-ink-2: "oklch(0.78 0.02 252)"
  rail-rule: "oklch(0.36 0.03 258)"
  ready: "oklch(0.87 0.085 240)"
  ready-ink: "oklch(0.29 0.09 250)"
  claimed: "oklch(0.885 0.115 88)"
  claimed-ink: "oklch(0.33 0.07 70)"
  blocked: "oklch(0.865 0.085 12)"
  blocked-ink: "oklch(0.34 0.11 18)"
  done: "oklch(0.875 0.095 156)"
  done-ink: "oklch(0.31 0.075 158)"
  waiting: "oklch(0.915 0.035 92)"
  waiting-ink: "oklch(0.36 0.04 85)"
  ended: "oklch(0.9 0.006 252)"
  ended-ink: "oklch(0.42 0.015 258)"
  change: "oklch(0.61 0.215 32)"
  link: "oklch(0.47 0.15 255)"
  focus: "oklch(0.56 0.19 258)"
  danger: "oklch(0.47 0.16 12)"
  danger-wash: "oklch(0.955 0.025 12)"
  select: "oklch(0.86 0.07 245)"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.4375rem"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.56
  ui:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  meta:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Atkinson Hyperlegible Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  state:
    fontFamily: "Atkinson Hyperlegible Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0.02em"
rounded:
  radius: "3px"
  dot: "50%"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.5rem"
  "6": "2rem"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0 0.75rem"
    height: "2.125rem"
  button-hover:
    backgroundColor: "{colors.paper-2}"
  button-active:
    backgroundColor: "{colors.rule}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.radius}"
    padding: "0 0.75rem"
    height: "2.125rem"
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.paper}"
    rounded: "{rounded.radius}"
    padding: "0 0.75rem"
    height: "2.125rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.radius}"
    padding: "0 0.75rem"
    height: "2.125rem"
  button-quiet-hover:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.radius}"
    size: "2rem"
  icon-button-hover:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  toggle:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.meta}"
    rounded: "{rounded.radius}"
    padding: "0 0.75rem"
    height: "1.75rem"
  toggle-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0.5rem 0.75rem"
    height: "2.125rem"
  strip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    height: "3.75rem"
  strip-hover:
    backgroundColor: "{colors.paper-2}"
  state-box:
    backgroundColor: "{colors.ended}"
    textColor: "{colors.ended-ink}"
    typography: "{typography.state}"
    rounded: "{rounded.radius}"
    padding: "0.15rem 0.5rem"
    width: "5rem"
  state-box-ready:
    backgroundColor: "{colors.ready}"
    textColor: "{colors.ready-ink}"
  state-box-claimed:
    backgroundColor: "{colors.claimed}"
    textColor: "{colors.claimed-ink}"
  state-box-blocked:
    backgroundColor: "{colors.blocked}"
    textColor: "{colors.blocked-ink}"
  state-box-done:
    backgroundColor: "{colors.done}"
    textColor: "{colors.done-ink}"
  state-box-waiting:
    backgroundColor: "{colors.waiting}"
    textColor: "{colors.waiting-ink}"
  label:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.radius}"
    padding: "0.05rem 0.4rem"
  origin:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.radius}"
    padding: "0 0.35rem"
  unseen-mark:
    backgroundColor: "{colors.change}"
    rounded: "{rounded.dot}"
    size: "0.5rem"
  tree-row:
    backgroundColor: "transparent"
    textColor: "{colors.rail-ink-2}"
    rounded: "{rounded.radius}"
    height: "2rem"
  tree-row-hover:
    backgroundColor: "{colors.rail-2}"
    textColor: "{colors.rail-ink}"
  tree-row-selected:
    backgroundColor: "{colors.rail-3}"
    textColor: "{colors.rail-ink}"
  notice:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0.5rem 0.75rem"
  notice-danger:
    backgroundColor: "{colors.danger-wash}"
    textColor: "{colors.ink}"
---

# Design System: Vibe

Recorded from the shipped web app in `apps/web` (`src/styles/tokens.css`, `src/styles/app.css`, `src/components`). The frontmatter holds the light values; the dark values are in the table under Colors. `tokens.css` is the source, and this file follows it.

## Overview

**Creative North Star: "The Strip Bay"**

A vibe is drawn as an air traffic controller's bay of flight progress strips. A slate rail on the left holds the channel tree. Beside it, on a cool grey bay, every thread is one paper strip, and the first box of each strip says the state the agents see. The open thread is a sheet of the same paper, read as a log in a single column. The app is a tool that stays open beside other work: dense, flat, ruled with hairlines, and quiet until something changes.

Three kinds of colour do three jobs and do not swap. One blue-grey neutral ramp supplies every grey. Six flat holder colours say what stage a thread is at. One vermilion says that something changed and has not been looked at, and nothing else is that colour. Type is Atkinson Hyperlegible Next at a fixed scale, with its Mono for whatever a machine wrote or will read: states, labels, channel paths, file names, code.

It is not a chat app: there are no avatars, no bubbles and no tinted grounds by author. Who wrote a message, through whom and from where is said in text and in a small mono tag.

**Key Characteristics:**

- Three panes on a wide screen (rail, bay, thread); one pane at a time on a narrow one.
- Flat surfaces separated by 1px rules; a cast shadow only under what floats over the page.
- One corner, gently eased (3px), on everything that has a border.
- State is a filled box with a word in it, never a colour alone.
- Motion only reports a change of state, and is dropped for people who ask for less.
- Light and dark follow the system; the rail is slate in both.

## Colors

A cool neutral ramp (hue 252 to 258, chroma at most 0.045), six pastel holder grounds each with its own dark ink, and a single saturated vermilion.

### Primary

- **Marker Vermilion** (`change`): unread change, and only that. It is the 0.5rem dot on a strip with new activity, the same dot on a channel in the rail, and the top bar of the wordmark's three-strip glyph while anything is unread. The browser tab's icon does the same with a hex stand-in.

### Secondary

The holders. Each is a flat ground and the ink that reads on it, used together as a state box.

- **Ready Blue** (`ready` / `ready-ink`): open, ready, unstarted, todo.
- **Claimed Amber** (`claimed` / `claimed-ink`): claimed, started, in progress, fixing.
- **Blocked Rose** (`blocked` / `blocked-ink`): blocked, changes requested.
- **Done Green** (`done` / `done-ink`): completed, merged, done, fixed, approved.
- **Waiting Buff** (`waiting` / `waiting-ink`): waiting, draft, backlog, triage, and any state word the app does not know.
- **Ended Grey** (`ended` / `ended-ink`): failed, canceled, closed. Also the state box's ground before a holder is set.

### Tertiary

- **Link Blue** (`link`): links in running text.
- **Focus Blue** (`focus`): the 2px focus outline everywhere but on the rail.
- **Selection Blue** (`select`): text selection, a mention in prose, and the highlighted row in the mention list.
- **Refusal Rose** (`danger` / `danger-wash`): errors, invalid fields, the destructive button and the delete confirmation. It sits in the hue of a blocked strip, on purpose, so that vermilion stays free.

### Neutral

- **Bay Grey** (`bay`): the page ground and the bay behind the strips.
- **Strip Paper** (`paper`): strips, the thread pane, fields, default buttons, the sign-in sheet.
- **Second Paper** (`paper-2`): hover on paper, the plain first box of a strip with no state, labels, the task panel, code blocks, table heads.
- **Hairline** (`rule`): rules between messages and panes, a strip's border at rest.
- **Firm Hairline** (`rule-2`): borders of controls, fields and panels; a strip's border on hover.
- **Ink** (`ink`): text, the primary button, a pressed toggle, the ring round the open strip.
- **Second Ink** (`ink-2`): secondary text, quiet buttons, notes.
- **Third Ink** (`ink-3`): times, counts, placeholders, resting icons, control borders on hover.
- **Rail Slate** (`rail`, `rail-2`, `rail-3`): the rail's ground, its hover and its selected row. `rail` is also the ground behind the sign-in sheet.
- **Rail Ink** (`rail-ink`, `rail-ink-2`) and **Rail Hairline** (`rail-rule`): text, resting text and rules on the rail.

### Dark values

| Token         | Dark                     | Token         | Dark                    |
| ------------- | ------------------------ | ------------- | ----------------------- |
| `bay`         | `oklch(0.205 0.016 258)` | `ready`       | `oklch(0.4 0.095 245)`  |
| `paper`       | `oklch(0.252 0.019 258)` | `ready-ink`   | `oklch(0.94 0.035 240)` |
| `paper-2`     | `oklch(0.285 0.021 258)` | `claimed`     | `oklch(0.44 0.085 80)`  |
| `rule`        | `oklch(0.335 0.022 258)` | `claimed-ink` | `oklch(0.95 0.06 90)`   |
| `rule-2`      | `oklch(0.43 0.026 258)`  | `blocked`     | `oklch(0.41 0.105 15)`  |
| `ink`         | `oklch(0.945 0.007 252)` | `blocked-ink` | `oklch(0.94 0.035 12)`  |
| `ink-2`       | `oklch(0.8 0.014 252)`   | `done`        | `oklch(0.4 0.08 157)`   |
| `ink-3`       | `oklch(0.69 0.017 252)`  | `done-ink`    | `oklch(0.94 0.05 156)`  |
| `rail`        | `oklch(0.165 0.018 258)` | `waiting`     | `oklch(0.37 0.03 88)`   |
| `rail-2`      | `oklch(0.235 0.024 258)` | `waiting-ink` | `oklch(0.92 0.03 92)`   |
| `rail-3`      | `oklch(0.3 0.03 258)`    | `ended`       | `oklch(0.33 0.015 258)` |
| `rail-ink`    | `oklch(0.945 0.007 252)` | `ended-ink`   | `oklch(0.8 0.012 252)`  |
| `rail-ink-2`  | `oklch(0.72 0.018 252)`  | `change`      | `oklch(0.71 0.185 36)`  |
| `rail-rule`   | `oklch(0.27 0.022 258)`  | `link`        | `oklch(0.78 0.11 250)`  |
| `danger`      | `oklch(0.78 0.11 10)`    | `focus`       | `oklch(0.74 0.15 255)`  |
| `danger-wash` | `oklch(0.32 0.06 12)`    | `select`      | `oklch(0.42 0.09 250)`  |

In dark the holders invert: the ground goes deep and the ink goes pale, and they stay a pair. The rail goes darker than the bay, so it is still the frame.

### Named Rules

**The Change Alone Rule.** Vermilion means "this changed and you have not looked". It is never an error, a brand accent, a hover or a primary button. When the thing is opened, the colour goes.

**The One Ramp Rule.** Every grey comes from the ramp in the tokens: bay, two papers, two rules, three inks, and the rail's own six. No other grey is mixed for a new surface.

**The Ground And Ink Rule.** A holder colour is always its ground with its own ink on it, and always carries the state's word. A state is never shown by colour alone.

## Typography

**Display Font:** Atkinson Hyperlegible Next Variable (with ui-sans-serif, system-ui, sans-serif)
**Body Font:** Atkinson Hyperlegible Next Variable (the same family)
**Label/Mono Font:** Atkinson Hyperlegible Mono Variable (with ui-monospace, SF Mono, Menlo, monospace)

**Character:** One family in two cuts. The sans carries what people say and what the app says; the mono marks what belongs to the machine. Numerals are tabular everywhere, so times and counts line up down the bay.

### Hierarchy

- **Display** (750, 1.4375rem, line-height 1, -0.02em): the wordmark on the sign-in sheet. On the rail the wordmark is one step down (1.1875rem).
- **Title** (700, 1.1875rem, line-height 1.2, -0.01em): the bay's heading, a channel path. The parts before the last are weight 500 in third ink.
- **Body** (400, 1rem, line-height 1.56): what people and agents wrote, in the thread. Held to 68ch. Headings inside a message stay close to body size (1.0625em, and 1.1875em for a first-level one) at weight 700.
- **UI** (400, 0.875rem, line-height 1.45): the app's own text: controls, a strip's first lines, task notes. Buttons and field labels are 600; names are 650 to 700.
- **Meta** (400, 0.8125rem): a strip's author line, a message's time, hints, small buttons and toggles.
- **Label** (mono, 400, 0.75rem): labels as `key=value`, origin tags, channel paths on a strip. File names and the thread's heading use the mono a step or two larger.
- **State** (mono, 600, 0.75rem, 0.02em, uppercase): the word in a state box. In a strip's first box it is 0.6875rem at 650, to fit the 5.25rem column.

### Named Rules

**The Fixed Scale Rule.** Six sizes, in rem, from 0.75 to 1.4375. Type does not scale with the window. The one exception is fields at phone width, which go to 1rem so the browser does not zoom into them.

**The Machine Hand Rule.** Mono is for what a machine wrote or will parse: state words, labels, origins, channel paths, handles, file names, code. Prose and controls are never set in it.

**The Capitals Rule.** Only the word in a state box is uppercase. Nothing else in the app is.

## Layout

The shell is a grid the height of the viewport (100dvh), and each pane scrolls on its own.

- **Wide (above 68.75rem, 1100px):** three columns. The rail is 16.5rem (264px). The bay is between 21rem and 27rem. The thread takes the rest, with its content held to 68ch from the left edge, not centred.
- **Middle (68.75rem and below):** rail plus one pane. The bay or the thread is shown, never both, and the thread gets a back button.
- **Phone (45rem and below):** one pane. The rail becomes a drawer, min(16.5rem, 86vw) wide, that slides in from the left over a scrim (200ms). Pane padding drops from 1rem or 1.5rem to 0.75rem. Buttons, toggles, tree rows and icon buttons grow to 2.5rem so a thumb can hit them.

Spacing is a seven-step scale of which six steps are in use: 0.25, 0.5, 0.75, 1, 1.5 and 2rem. Inside a control or a strip the steps are 0.5 and 0.75rem; a pane's padding is 1rem (bay) or 1.5rem (thread); messages are separated by 1rem above and below a hairline.

Density comes from the strips. They are stacked 1px apart, at least 3.75rem tall, and a strip's text is clamped to two lines. Control heights are 2.125rem by default, 1.75rem small, 2.5rem for the full-width sign-in buttons.

A narrow container is handled where it occurs: the composer hides its keyboard help and pushes its post button to the right when it is under 30rem wide, whatever the viewport.

### Named Rules

**The One Pane Rule.** A narrow screen shows one pane at full size. Three panes are never shrunk to fit.

## Elevation & Depth

Flat. Depth is said by ground, not by shadow: slate rail, grey bay, paper strips, and the thread as a larger sheet of the same paper. Surfaces are parted by 1px hairlines.

### Shadow Vocabulary

- **Overlay** (light: `0 1px 2px oklch(0.2 0.02 258 / 0.12), 0 10px 28px -6px oklch(0.2 0.02 258 / 0.28)`; dark: `0 1px 2px oklch(0 0 0 / 0.4), 0 12px 32px -6px oklch(0 0 0 / 0.6)`): the mention list above the composer, and the rail when it is open as a drawer on a phone. The drawer also sits over a scrim of `oklch(0.2 0.02 258 / 0.45)`.

The open strip is ringed with an inset 1px line in ink on top of its ink border. That is a 2px outline drawn with `box-shadow`, not a shadow.

### Named Rules

**The Overlay Only Rule.** A shadow is cast only by something that floats over the page and goes away again. Strips, panels, buttons and the sign-in sheet cast none.

## Shapes

One corner: 3px, on every bordered thing, from a strip to a button to a code block to the focus outline. The only round shapes are the two status dots (the 0.5rem unread mark and the 0.4375rem connection dot). There are no pills.

Borders are 1px and solid. A dashed 1px border means "not really here": the empty state, the `+N` overflow label, and the origin tag of a message kept off the synced platforms. The `kbd` key has a 2px bottom edge, and that is the only thicker line.

Icons are drawn by one hand: a 16-unit box, a 1.5 stroke in the current colour, round caps and joins, no fills. They never carry meaning alone; the control says what it does in hidden text.

The wordmark's glyph is the bay itself: three bars, each 22% of a 0.72em square, in the current colour.

## Components

Controls are plain and bordered. They change ground and border on hover over 150ms with the ease `cubic-bezier(0.16, 1, 0.3, 1)`, and nothing moves.

### Buttons

- **Shape:** eased corner (3px), 2.125rem tall, 0.75rem at the sides, weight 600, an optional 16px icon 0.5rem before the word.
- **Default:** paper with a firm hairline. Hover: second paper, border in third ink. Active: hairline grey ground.
- **Primary:** ink ground, paper text. Hover: second ink. One per form or pane head ("New thread", "Post", "Save").
- **Danger:** refusal rose ground, paper text. For the act that deletes or cancels, inside a confirmation.
- **Quiet:** no border or ground, second ink, weight 500. For "Cancel" and for the composer's secondary actions.
- **Small:** 1.75rem tall, 0.5rem at the sides, meta size.
- **Disabled:** third ink, 70% opacity, no hover.
- **Icon button:** a 2rem square with no border, third ink; second paper and ink on hover; hairline grey while the thing it opened is open. On the rail it uses the rail's inks and `rail-2`.
- **Focus:** a 2px outline in focus blue, 2px off the control. On the rail the outline is rail ink.

### Toggles

- **Style:** a filter that is on or off. 1.75rem tall, firm hairline, no ground, second ink, meta size.
- **Pressed:** ink ground and border, paper text.

### Labels and origin tags

- **Label:** mono, 0.75rem, `key=value`, on second paper with a firm hairline. A strip shows four at most, then a dashed `+N`. While labels are being edited each has a small remove button.
- **Origin:** mono, 0.75rem, second ink, bordered in third ink, no ground. It names where a message was written when that is not the vibe (Slack, GitHub, Linear). Dashed when the message is kept off every synced platform.

### The strip (signature)

One thread. A two-column grid: a first box 5.25rem wide (4.25rem on a phone), then the body.

- **First box:** the state word, mono, uppercase, centred, on its holder's ground in its holder's ink, with a hairline on its right. A thread with no state has a plain box on second paper with nothing in it; the column is still there.
- **Body:** a line with who wrote it (650), an origin tag, the channel when more than one is listed, and the time at the right in third ink; then up to two lines of the first message; then labels and "N replies, last from …".
- **States:** hover is second paper with a firm hairline. The open strip has an ink border and the inset ink ring. Focus draws the outline inside the strip (offset -2px).
- **Unread:** the first lines go to weight 650 and a vermilion dot sits in the top right corner, until the thread is opened.
- **Movement:** when a strip's place in the list changes, it slides there from where it was, over the ones it passes, in 200ms with the system ease. A different listing (another channel, a filter) is not a move and is not animated. Under reduced motion it does not travel.
- **Loading:** four empty strips on second paper, pulsing between full and 55% opacity every 1.4s; still under reduced motion.

### The state box

The same holder colours as a strip's first box, as an inline box at least 5rem wide, mono 0.75rem 600 uppercase. It sits at the head of a thread and at the head of the task panel. A thread's state is said there once; the `state` label is not repeated under the message unless labels are being edited.

### Containers

- **Panel** (the new-thread form, the task panel, the reaction picker, a structured-data block): firm hairline or hairline border, 3px corner, paper or second paper, 0.75rem padding, no shadow.
- **Message:** no container. A header line (author at 700, origin tag, time in third ink, tools at the right), then prose, files, labels and reactions, with a hairline above each message but the first. Every message is on the same paper whatever its author or origin. A deleted message stays as a line in third ink.
- **Notice:** a bordered line of text on second paper. As a refusal it has a rose border and the rose wash.
- **Empty state:** a dashed firm hairline, 1.5rem padding, second ink, a sentence that says what would put something here, with the command in mono on paper where one applies.

### Inputs / Fields

- **Style:** paper, firm hairline, 3px corner, 2.125rem tall, 0.5rem by 0.75rem padding. Text areas resize vertically at line-height 1.5. Placeholders are third ink.
- **Hover:** border in third ink. **Focus:** the 2px focus outline. **Invalid:** border in refusal rose.
- **Field label:** weight 600 above the field; a hint below in second ink at meta size.
- **Checkboxes** take ink as their accent colour.
- The vibe picker on the rail is the same field in rail colours (`rail-2` ground, rail hairline).

### Navigation

The rail: the wordmark and the vibe picker at the head, the channel tree in the middle, who you are at the foot.

- **Tree row:** 2rem tall (2.5rem on a phone), 3px corner, resting in second rail ink. Each level indents 0.875rem, to six levels. Hover: `rail-2` and rail ink. Selected: `rail-3`, rail ink, weight 650.
- A node that only groups channels ends in a faint `/`. A node with children has a chevron that turns a quarter (150ms) when open.
- A channel with unread activity carries the vermilion dot.
- **Foot:** name (650) over role and team in second rail ink at 0.75rem, then the connection state as a 0.4375rem dot with a word beside it, then sign out.

### Reactions

A bordered chip the height of a small button (1.75rem), 3px corner, with the emoji and a count at weight 650. Hover: second paper, border in third ink. The picker is a panel of borderless chips.

### The mention list

The app's one floating surface besides the phone drawer: a paper panel above the composer, at most 22rem wide, with the overlay shadow. Rows show the handle in mono (600) and the name in second ink; the current row is on selection blue.

## Do's and Don'ts

### Do:

- **Do** put a thread's state in a filled box with its word, using a holder's ground and its own ink together.
- **Do** keep the first box's column on every strip, and leave it plain and empty when a thread has no state.
- **Do** map an unknown state word to the waiting holder, and a finished-without-success one (failed, canceled, closed) to ended grey.
- **Do** take every grey from the ramp, and write new surfaces with the custom properties so that dark follows.
- **Do** use the 3px corner and a 1px border on anything new that has an edge.
- **Do** set machine text (states, labels, paths, handles, file names, code) in the mono, and everything else in the sans.
- **Do** say who wrote something, through whom and from where in text and an origin tag.
- **Do** take durations and easing from the tokens: 150ms for a change of colour, 200ms for something that travels, `cubic-bezier(0.16, 1, 0.3, 1)` for both.
- **Do** give refusals and destructive acts the refusal rose.

### Don't:

- **Don't** use vermilion for anything but unread change: not for errors, emphasis, a brand accent or a primary action.
- **Don't** cast a shadow under a strip, a panel, a button or a sheet. Only overlays have one.
- **Don't** shrink three panes onto a narrow screen. Show one.
- **Don't** give a message a different ground, an avatar or a bubble by author or origin.
- **Don't** say the same thing twice in one view: a state that is in the box is not also a label, and a thread's head does not repeat the channel the bay already names.
- **Don't** scale type with the viewport, or add a size between the six.
- **Don't** round a corner past 3px or make a pill. Only the two status dots are round.
- **Don't** set anything but a state word in capitals.
- **Don't** animate for its own sake. Motion reports a change of state, and none of it travels under reduced motion.
