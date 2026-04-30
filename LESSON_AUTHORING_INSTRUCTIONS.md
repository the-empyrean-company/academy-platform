# Qargo Academy: Lesson Authoring — project instructions

This file is the canonical brief for the companion content project. Paste the contents into that project's instructions field. The companion project is responsible only for **writing lesson content**. The platform itself (`index.html`, block renderers, routing, certificate logic) is owned by the Academy platform project and must not be touched from here.

## 1. What this project does, and what it does not do

In scope:
- Take Qargo product knowledge and turn it into lesson content that drops into the Academy platform's `MODULES` array.
- Produce one lesson at a time as a JavaScript object literal whose `blocks` field is a list of supported block types.
- Follow the v2 module and lesson map exactly. Do not invent modules, rename modules, reorder modules, or merge lessons without explicit approval.

Out of scope:
- Editing `index.html`, the block renderers, the routing, the home page, the certificate, or any styling. Those are platform concerns.
- Adding new block types. The current 14 are the full set. If a lesson "needs" a block that does not exist, surface that as a request, do not invent the block.
- Changing the localStorage contract, the completion rules, or the role list.

Hand-back format: a ready-to-paste object that matches the existing M0 structure in `index.html` (lines 3045 onward in the platform repo). One lesson per delivery unless asked otherwise.

## 2. Platform architecture (one-paragraph reminder)

Single-file SPA, vanilla JS plus CSS, no build step. Hash routing. Content hierarchy is **Learning Path → Modules → Lessons → Blocks**. Each lesson is a list of blocks. Each block has its own renderer with a `markDone` callback. A lesson is complete only when all its blocks have signaled done. A module is complete only when all its lessons are complete. The path is complete only when all its modules are complete. The certificate unlocks at path completion. Progress is tracked in `localStorage` per browser; lessons are tracked by ID, not index, so reorders within a module break nothing.

Read `CONTEXT.md` in the platform repo for the full architecture before authoring.

## 3. The 14 building blocks (descriptions and required fields only)

Use the right block for the cognitive job. Authors should reach for variety inside a lesson: a single text block followed by four quizzes is worse pedagogy than a text, a process, a flipcard set and one quiz. The reference live page is `#/blocks` in the platform; visit it to see every block working.

Common to all blocks: `type` (string, required, one of the names below) and usually a `title`.

| Block | `type` value | What it is for | Key fields |
|---|---|---|---|
| Text | `text` | Standard prose. Marks done on render. | `title`, optional `lead`, `body` |
| Image | `image` | One image with optional caption. Marks done on render. | `src`, `alt`, optional `caption` |
| Carousel | `carousel` | Slides the learner pages through. Marks done once every slide is viewed. | `title`, `slides[]` where each slide has `src`, `alt`, `caption` |
| Accordion | `accordion` | Expand-to-reveal Q and A rows. Every row must be opened to mark done. | `title`, optional `intro`, `items[]` with `q` and `a` |
| Summary | `summary` | Highlighted key takeaways. Marks done on render. Use at the end of a lesson. | `title`, `points[]` (each a sentence) |
| Quiz | `quiz` | Single-select multiple choice. Marks done on submit. | `title`, `question`, `options[]`, `correct` (index, 0-based), `explanation` |
| Fill in the blanks | `fillblanks` | Sentence with `{answer}` tokens that become inline inputs. Marks done on full correct or after Reveal. | `title`, optional `prompt`, `text` (with `{answer}` tokens) |
| Match | `match` | Drag terms onto definitions. Marks done when every pair is correct. | `title`, `pairs[]` with `term` and `definition` |
| Flashcards | `flashcards` (alias `flipcard`) | Click-to-flip card deck. Marks done once half the deck is flipped. | `title`, optional `intro`, `cards[]` with `front` and `back` |
| Process | `process` | Numbered vertical stepper. Click a step to expand. Every step must be opened. | `title`, `steps[]` with `title` and `body` |
| Timeline | `timeline` | Vertical date-anchored events. Fades in on scroll. Marks done on render. | `title`, `events[]` with `date`, `title`, `body` |
| Milestone | `milestone` | Celebratory marker between sections. Confetti on first scroll-in. Marks done on CTA click. | `headline`, `message`, `cta` |
| Embed | `embed` | Iframe wrapper for Storylane, YouTube, Loom, virtual environments. Marks done on Mark complete. | `title`, `kind`, `url`, optional `caption`, optional `ratio` (default `16/9`) |
| AI Tutor | `tutor` | Lesson-aware chat panel. Reads the lesson body for grounding. Marks done on first answer. | `title`, optional `subtitle`, optional `suggestions[]` (3 to 5 starter prompts) |

Constraints to respect:
- Quiz `correct` is a zero-based index into `options`. Always include an `explanation` string.
- Carousel and Accordion completion both depend on full traversal, so use them when you actually want the learner to see every item.
- Embed `url` must be an iframe-safe URL (`youtube.com/embed/...`, Storylane share, Loom embed). Do not use a regular YouTube watch URL.
- Tutor only makes sense once a lesson has enough text or summary or accordion or process or timeline content for the system prompt builder to ground the model. Do not place a Tutor first.

## 4. Lesson rhythm and tone

The model M0 lesson uses this rhythm and authors should match it unless the source content demands otherwise:

1. One **text** block to set the idea (lead plus body, 3 to 6 sentences).
2. One **interactive** block that reinforces the idea (accordion, flipcard, match, process, fillblanks, or carousel).
3. Optionally a second supporting block (image, embed, timeline) when the topic benefits from it.
4. One **summary** block with three takeaways.
5. One **quiz** with a single question, four options, an explanation.

Rough length: 4 to 6 blocks per lesson. A lesson should take a learner 5 to 10 minutes including the quiz.

Tone: plain English, second person ("you"), short sentences, no marketing copy, no superlatives. The platform's house style avoids em dashes and emojis. Use commas, colons or full stops instead of em dashes.

## 5. Source data: where to draw lesson content from

The user has curated source databases per module in Notion. Always read the matching database for the module you are writing before drafting. Use other Qargo sources only to fill gaps.

Index page: [Data Collection for Creation of Learnings](https://www.notion.so/qargo/Data-Collection-for-Creation-of-Learnings-337e32e8f8c88033a47cea37c9a7f5bf)

Per-module source databases:

- **M0 Logic of Qargo** → [Understanding Qargo (how it all interacts)](https://www.notion.so/qargo/489eab6859b34ee69890e53c3e32db94)
- **M1 Essential Setup** → [Essential Setup](https://www.notion.so/qargo/2c7025963e66493aa668ca608eaeacf5)
- **M2 Order Entry** → [Order Entry](https://www.notion.so/qargo/33f87c241bf5416ab667e088f84aabda)
- **M3 Stops and Trips** → [Stops & Trips](https://www.notion.so/qargo/33bbb22abb08405299c341146c69b2b9)
- **M4 Planning Basics** → [Planning Basics](https://www.notion.so/qargo/41a2d5783e2d472696ef86ab3f7b7f14)
- **M5 Finance and Invoicing** → [Finance Basics — Invoicing & Credit Notes](https://www.notion.so/qargo/f9236d97267640a9bcb383a2b32b4b2b)
- **M6 Rate Cards** → [Rate Cards](https://www.notion.so/qargo/3cdc3eba39e24a7689a29395c1fc25a8)
- **M7 Advanced Configuration** → [Configuration — Surcharges, Vehicles & Tasks](https://www.notion.so/qargo/e5ce6bd7376f4637b87f2d6ceb7a2cb1)
- **M8 Reporting and Exports** → [Reporting & Exports](https://www.notion.so/qargo/eaa71aff518849448caf9d3088ee8077)
- **M9 Document Templates** → [Document Templates](https://www.notion.so/qargo/c6e85721da0149cabcfd7deaeefad8c9)
- **M-Admin Bulk Import and Maintenance** → no dedicated source database yet. Pull from M1 Essential Setup database, the Qargo Knowledge Base on Notion (synced from help.qargo.com), and confirm gaps with the user.

Secondary sources, in priority order, when the per-module database is thin:

1. The **Qargo Knowledge Base** in Notion, synced from `help.qargo.com`. Canonical for screen names, terminology, current product behaviour. Use the `qargo-qa` skill for questions you cannot answer from the per-module database.
2. The **Bugs & Features database** in Notion. Use this when the lesson needs the "why" behind a feature or the most recent functional spec.
3. **`#app_announce_features`** in Slack. Use for the most recent product updates and the tone the product team uses internally.
4. **Front email** (shared inbox) and **customer Intercom conversations**. Use to find real questions customers ask. These are gold for quiz distractors and for the FAQ-style accordions.
5. The platform `index.html` Module 0 content. Treat as the gold standard reference for tone, depth and structure.

Always cite the Notion source URL inside the lesson hand-off (in a comment alongside the lesson object) so reviewers can audit.

## 6. Learning Path: modules and lessons (v2)

This is the strict scope. Source: [1st Learning Path: Modules and Lessons (v2)](https://www.notion.so/qargo/1st-Learning-Path-Modules-Lessons-v2-351e32e8f8c88112bbd7fba5e4cf07a0). v2 incorporates feedback from Liam Betts and Lee Hume on v1.

Path: **The first mile: all aboard Qargo**. Audience: Qargo super admins.

Eleven modules. Each numbered item below is one lesson; the indented bullets are the points the lesson must cover.

### M0 Logic and Orientation
*Built and live in the platform. Treat as the reference for tone and structure.*

1. Introduction: Welcome to Qargo, what this learning path will give you
   - Key vocabulary
   - What a TMS is, what Qargo is not
   - The problem Qargo is designed to solve
   - How to get help: in-app help, KB, support, the Qargo Chatbot
2. The four core objects: Orders, Stops, Trips, Rate Cards at a glance
   - The Order, what it represents in the real world (plus a quick tour of how Rates / Order Input feeds it, sets up the "why" before M1)
   - The Stop and why it is separate from the order
   - The Trip and how Qargo turns planned work into executable work
   - The Rate Card and why pricing lives as structured data
   - End-to-end lifecycle of a shipment
3. Who does what: the five roles that touch this data
   - Where each role spends their time
4. The four areas of the Qargo interface
   - Orders, Planning, Invoicing, Rates and Config
   - The Dashboard and what it sits across
5. Wrap-up
   - Summary, quiz, comfort questionnaire, reminder of where to find help

### M1 Essential Setup
*Master data Qargo needs before operations begin. Bulk-import content has been moved to M-Admin.*

1. Introduction (what this module contains, key vocabulary, key takeaways)
2. What master data is and why Qargo needs it
3. The order of operations: what to create first, and why
   - Resources: drivers, vehicles (basic record only, categorisation is in M7), trailers and equipment, containers (intermodal)
   - Companies: customer, supplier, carrier, subcontractor; adding contacts
   - Locations: warehouses, depots, stop points
     - Callout: most operational stop locations are created on the fly during order creation
     - Callout: Qargo uses Google Maps to speed up location entry
     - Linking locations to companies (shipping, billing addresses)
   - Products and product units (pallet, kg, m³, pieces) and when to use which
4. User roles and permissions: the basics
   - Creating user accounts
   - Teams, departments, business units, when you need them
5. Wrap-up

### M2 Order Entry
1. Introduction
2. Anatomy of an order: fields and what each one means
   - Revenue, General, Routing, Documents and tasks, Consignments
   - Goods and products on orders: quantity, weight, volume
   - Special instructions and references
   - Order numbers and external references (PO, booking ID)
   - Order statuses
3. Creating an order
   - Using Qargo Intelligence
   - Single from scratch / copying existing
   - From template or quote
   - Editing an order after creation
4. Working with orders
   - Cancelling an order vs marking failed
   - Cancelling an order vs cancelling a consignment
   - Duplicating
   - Bulk creating: manual batch and import
   - Searching: filters, quick searches, saved views
   - Common order-entry errors
5. Order list views: configuring columns
6. Wrap-up
   - Includes hand-off to planning: what needs to be complete before a planner sees it

### M3 Stops and Trips
1. Introduction
2. Why Qargo separates stops from trips: the core concept
   - What a stop is: pickup, delivery, other types
   - What a trip is: the execution container
   - Lifecycle: order → stops → trip → completion
3. Building trips
   - How Qargo auto-groups stops
   - When and why to build manually
   - Mixing manual and auto-planned in one day
   - Trip templates for recurring work
   - Trip groups
4. Status and dates
   - **Trip status flow: Planned → In Transit → Completed** (trips are not directly cancelled in the front end; cancelling the order cancels the trip behind the scenes)
   - Stop status: visited, skipped, failed
   - Date types: requested, planned, actual, estimated
   - How stop statuses roll up to trip status
   - How updates flow back: driver app for in-house, Subcontractor Portal for subcontractors
5. Managing active trips
   - Adjusting stops
   - Splitting and merging
   - What happens when an order is cancelled mid-trip
   - Common stop / trip confusion and how to diagnose
6. Wrap-up

### M4 Planning Basics
1. Introduction
2. The planning board
   - What it is and who owns it
   - Reading the board: rows, columns, time axis
   - Filtering: vehicle, driver, depot, date
   - Views: daily, weekly, resource-based
   - Map view
   - **Table view** (when a list is faster than the board)
3. Assigning work
   - Drag-and-drop assignment
   - Bulk and quick-assign
   - Driver and vehicle availability
   - Conflicts and double-bookings
   - Driver hours and rest-time indicators
   - Route optimisation, what Qargo does and does not do automatically
4. Rescheduling and exceptions
   - Within the day, across days
   - Cancellations and no-shows
   - Late pickups, failed deliveries
5. Running the day
   - Publishing plans to drivers
   - Live trip monitoring during the day
     - How Qargo calculates planned routes
     - How Qargo calculates ETAs
     - How ETAs update during the day (driver-app pings, traffic, stop progress)
   - Debriefing a completed day
6. Wrap-up

### M5 Finance and Invoicing
1. Introduction
2. The invoicing flow
   - How Qargo bridges operations and finance
   - **The golden rule: Order = Revenue, Trip = Cost.** Sales invoicing is always done on orders; trips only enter the picture for costs.
   - The sales invoicing cycle: from completed order to sent invoice
   - The cost cycle: from completed trip to subcontractor / driver cost
   - Auto vs manual invoice generation
3. Running sales invoices (orders)
   - Setting up an invoice run
   - By period vs by order
   - Reviewing draft invoices
   - Editing before send
   - Approving and finalising
   - Invoice statuses
   - Sending: email, portal, export
   - **Exporting to the accounting system as the final step**, typically as the invoice is raised, not at month-end
4. Credit notes and disputes
   - When to use a credit note
   - Creating one, linking to original invoice
   - Handling disputes
5. Costs: purchase invoices and self-billing (trips)
   - Purchase invoices, the basics
   - Self-billing overview
   - How trip data feeds into costs
6. Month-end close
   - Common invoicing errors: missing rates, wrong customer, unit mismatches
   - What to check before closing a period
   - Reconciling sales and costs
7. Wrap-up

### M6 Rate Cards
*The critical module. The #1 struggle across all regions. Goal: users understand the logic and can make basic changes themselves post-go-live.*

1. Introduction
2. What a rate card is
   - The problem it solves
   - Why structured pricing instead of documents
   - The hierarchy: rate card → transport charge → calculation table
   - Navigating to a rate card
3. Building blocks
   - Transport charge types and when to use each
   - Calculation tables: how they work
   - The "multiply by metric" method
   - The formula method
   - Choosing between formula and multiply
4. Charge Templates
   - What they are and the time they save
   - Creating one
   - Applying to a new rate card
   - Updating templates without breaking existing rate cards
5. The top 5 configurations
   - Overview
   - Flat rate per order
   - Per-kilometre pricing
   - Per-pallet / per-unit pricing
   - Zone-based pricing
   - Weight or volume break pricing
   - Combining methods within one rate card
   - Surcharges on rate cards (overview, deep dive in M7)
6. UK pallet networks
   - Collections logic, deliveries logic, local-area pricing
7. Maintaining rate cards
   - Validity periods
   - Year-start updates
   - Bulk updates across multiple cards
   - Testing before going live
   - Copying for a new customer
   - Permissions
8. Troubleshooting: diagnosing "why is my rate wrong?"
9. Wrap-up

### M7 Advanced Configuration
1. Introduction
2. What "advanced configuration" covers, and what stays in M1
3. Vehicle categories
   - What they are and how planning uses them
   - Creating them
   - Capacity and constraints
4. Surcharges
   - What they are and when to use them
   - Types: fixed, percentage, per-unit
   - Creating a fuel surcharge
   - Creating a toll or zone surcharge
   - Linking to customers or rate cards
5. Tasks
   - What they are and why Qargo uses them
   - Task levels: stop, consignment, order, trip, choosing the right one
   - Creating a task type
   - **Using conditions to create tasks automatically.** Conditions create tasks; they do not run them. Running tasks is handled by front-end task config in the driver app and order screens.
   - Condition examples: ADR, temperature-controlled, high-value goods
   - Task visibility in the driver app
   - Mandatory vs optional
6. Other configuration
   - Trip templates for recurring setups
   - Working hours and shift configuration
   - Stop types and their behaviour
   - Default values and how they flow through to orders
   - Workflow automation: event-based rules (overview)
7. Ownership
   - Who should own configuration changes post-go-live
8. Wrap-up

### M8 Reporting and Exports
1. Introduction
2. Why reporting matters
   - What questions Qargo can answer
   - Reports vs exports vs dashboards
   - Standard reports that ship with Qargo
3. Using exports
   - Types: orders, trips, invoices, master data
   - Choosing the right export
   - The export builder: picking fields
   - Filtering: date range, status, customer
   - Excel, CSV, PDF, when to use which
4. Reusing and sharing
   - Scheduling recurring exports
   - Saving a reusable layout
   - Sharing with colleagues
5. Advanced reporting: BigQuery
   - **What BigQuery is and how Qargo feeds it**: replicated copy of the operational database
   - **Refresh cadence: roughly every 2 hours**, not live
   - **Best used for non-operational reporting** (BI, finance, trend analysis); never for live operations
   - API access for reporting: overview and when to involve IT
   - What cannot be exported and why
   - Where to go when the data you need is not in a standard report
6. Common reports to build
   - Customer-facing KPI report
   - Internal ops KPI report
   - Trip profitability
   - Driver performance
   - Customer health (volumes, on-time %, margin)
7. Pitfalls: timezones, status filters, duplicates
8. Wrap-up

### M9 Document Templates
*Advanced. For managers ready to customise driver and customer documents.*

1. Introduction
2. What document templates are
   - What they do, the problem they solve
   - Document types: CMRs, delivery notes, invoices, labels
   - Driver-facing vs customer-facing
3. Anatomy of a template
   - Blocks, placeholders, logic
   - The template editor
   - Plain text, merge fields, why they are separate
4. Writing template logic
   - Handlebar expressions: a plain-language intro
   - Accessing order, stop, trip, customer data
   - If/then logic
   - Loops: listing multiple consignments or stops
   - Conditional visibility of blocks
5. Formatting and language
   - Dates, numbers, currencies
   - Language and translation
6. Managing templates
   - Customer-specific
   - Previewing with real data
   - Version control: drafts and publishing
   - Where templates are triggered (manual, event-based, batch)
7. Troubleshooting
   - Common errors: missing fields, broken logic
   - When to configure yourself vs ask Qargo for help
8. Wrap-up

### M-Admin Bulk Importing and Maintenance
*New standalone module for super admins, split out from M1. Owners: super-user / sysadmin only. Note: this is the eleventh module and is not yet present in the platform's MODULES array. Confirm with the user before publishing the first lesson so the platform side can extend the array.*

1. When to use bulk import vs manual creation
   - Implementation / go-live loads vs day-to-day maintenance
   - What can and cannot be bulk-imported
   - Risks of bulk import on a live tenant
2. Bulk-importing master data: CSV / Excel
   - Templates Qargo provides
   - Filling out a template correctly
   - Dry-run / validation
   - Running the actual import and reading the result log
3. Keeping master data clean
   - Naming conventions across drivers, vehicles, locations, products, customers
   - Common mistakes to spot before import
   - Duplicate detection and merging
4. Fixing bad master data after go-live
   - Editing vs deactivating vs deleting
   - Fixing without breaking historic orders, trips, invoices
   - Bulk updates after go-live
5. Audit and ownership
   - Who should hold super-admin permissions
   - Logging and traceability of bulk changes
6. Wrap-up

## 7. Authoring workflow per lesson

1. **Confirm the target.** Identify which module and which lesson number from section 6. Do not start without that anchor.
2. **Read the source.** Open the matching Notion database from section 5. Read every page that touches the lesson's bullets. Note unanswered points; surface them to the user instead of guessing.
3. **Outline.** Sketch the block sequence (text, then which interactive, then summary, then quiz). Match the M0 rhythm unless the source content demands otherwise.
4. **Draft.** Write the lesson as a JS object literal with `id`, `title`, and `blocks`. The lesson `id` follows the existing convention: `m{N}-l{N}-{kebab-case-title}` (e.g. `m1-l3-order-of-operations`). For M-Admin use prefix `madmin-`.
5. **Self-review.** Check: do all interactive blocks pull their weight, is there a lead, is the summary three short points, does the quiz have exactly four options with one unambiguously correct, is the explanation written, no em dashes, no emojis.
6. **Hand off.** Return the lesson object plus a short rationale: which source pages were used (with URLs), which gaps the user needs to clarify, and any flagged risks (e.g., "this lesson assumes Subcontractor Portal is enabled; confirm").
7. **Verification step.** Before saying done: read the object back, confirm every required field for every block is present, and confirm the lesson has at least one block whose completion is non-trivial (so it does not auto-complete in one second).

## 8. House rules to keep

These come from the platform owner and from CONTEXT.md. Non-negotiable.

- **Do not remove or substitute interactive blocks.** Block dispatcher, completion contract and the path/module/lesson hierarchy are protected. Confirm with the user before any change.
- **No em dashes.** Use commas, colons or full stops.
- **No emojis** (including in suggestion lists for the Tutor).
- **Plain English, second person.** No marketing copy, no superlatives, no hedge phrases like "as you may know".
- **Brand tokens for any inline styling references**: brand green is `#00E85B` (`--brand-600`), brand navy is `--brand-900`. Do not invent colours.
- **Lesson IDs are stable.** Once a lesson ID has been delivered, do not rename it; learners' completion state is keyed on it.
- **Embeds:** prefer Storylane interactive demos for product walkthroughs. Use YouTube embeds for short videos only.
- **Length:** 4 to 6 blocks per lesson, 5 to 10 minutes total. If a topic blows past that, propose a split before drafting.

## 9. Reference: the M0 example

The Module 0 lesson set in `index.html` (the platform repo) is the worked example. Read all five M0 lessons before writing your first lesson. They show:

- How a lead paragraph sets up a body paragraph.
- How accordions and flipcards split a list into "scan" and "study" surfaces.
- How a quiz explanation rewards the correct answer, not just confirms it.
- How a wrap-up lesson pulls the module's threads together and points forward.

When in doubt, mirror M0.

## 10. Open questions to confirm before authoring starts

1. M-Admin is in v2 but not yet in the platform's `MODULES` array. Should the array be extended now, or held until M0 through M9 are filled?
2. Should every Wrap-up lesson include the same comfort questionnaire format, and if so, which block type captures it best (the platform has no native survey block; closest fit is a `tutor` reflection prompt or an `accordion` with self-rated rows)?
3. M-Admin has no dedicated source database. Confirm the user wants the author to pull from M1 plus the Knowledge Base, or wait for a dedicated source page.
