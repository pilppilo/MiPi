---
"mipi": minor
---

COD-244: frontend slice 1 (COD-243). The web app is a mobile-first installable app in the D · Spaces style.

**Added**

- On a phone, chat is the whole screen. ☰ slides the main screen aside to show the drawer: the bots, each with its own coloured mark that glows while it works and fades while it sleeps (with Working, Waiting or Asleep under its name), the connection and usage line, and Settings and New bot at the bottom. Picking a bot or cobot, opening Settings, Escape or a tap on the main screen closes it, and focus goes back where it belongs. On a wide screen the drawer is a sidebar and the chat a card beside it.
- The open bot's mark sits small at top centre; tapping it shows the bot's details (its purpose, model and profile pickers, token and cost figures, tools, rename and archive, system entries, Activity), so the transcript keeps the screen. The right-hand slot stays empty until a voice capability exists.
- The owner's messages are pills and the bot's replies plain text; tool calls fold into a quiet line each. The composer floats above the bottom edge and the keyboard, and grows with what you type.
- Light and dark follow the system, with matching theme colours. Headers, the drawer, sheets and the composer keep clear of notches and gesture bars (`viewport-fit=cover`, safe-area insets), the keyboard resizes the page instead of covering the composer (`interactive-widget=resizes-content`), and controls are at least 44 px tall on touch screens.
- MiPi can be installed as an app: `manifest.webmanifest` (fetched with credentials, so Cloudflare Access lets it through), real icons (SVG, PNG and maskable), and a service worker that caches nothing and has no `fetch` handler. A reload after the Access session expires therefore reaches sign-in, never a stale copy of the app.

- Plain names everywhere the owner reads them. Tools show as "Reminders", "Past chats", "Web pages" and so on, and profiles as toolkits ("Everyday", "Just chat", "MiPi's toolkit"). Models use their catalog names and thinking levels read Off, Light, Medium or Deep. A name the web app doesn't know is spelled out readably (`brand_new_tool` → "Brand new tool"). The ids stay on the wire and in each chip's title. The agent sending names of its own is COD-247.
- New bot is a sheet of its own: a name, what it's for (its standing instructions), and the toolkit to use as cards, each with what it offers. Nothing behind the sheet takes input while it is open, and Escape or ✕ closes it.

**Changed**

- Settings is tidied: each section opens with its title and a short note, its content sits on cards, and Close is a round ✕. Diagnostics has a health card (counts, alarm, live state, Refresh, Ask MiPi), a filters card (Severity and Source as segmented controls, Pause scroll), and the events table on a card of its own.
- A bot's details are rows: Model, Toolkit (with what it offers) and "It can use" (its tools as chips), then its figures on one line, then its actions (New cobot, Rename, Archive) and Activity.
- Settings → Diagnostics' event table scrolls inside its own box on a narrow screen, and Settings' sections are a row of tabs there. The landing page and the unlock gate are centred, padded pages.
- A purpose bot's purpose moved from the bots list to its details.

**Pi Durable**

- No version change (1.6.1) and no ledger change.

**Migration**

- None. Client-only.
