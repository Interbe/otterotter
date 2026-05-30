# Otterotter — site (Phase 1 MVP)

An interactive map of contact improvisation & eco-somatic events across Europe.
This folder is the **website**. It reads two plain data files and needs no backend to run.

```
site/
├── index.html          ← the page
├── css/styles.css      ← styling
├── js/app.js           ← map, filters, list, gallery, form logic
└── data/
    ├── events.json     ← the events shown on the map (15 samples for now)
    └── facilitators.json ← facilitator profiles
```

## How to preview it on your computer

You can't just double-click `index.html` — browsers block it from loading the
data files for security. Run a tiny local server instead:

1. Open Terminal and go into this folder:
   `cd "path/to/ES & CI events/site"`
2. Start a server (Python is pre-installed on Mac):
   `python3 -m http.server 8000`
3. Open your browser at: **http://localhost:8000**
4. Press `Ctrl+C` in Terminal to stop it when done.

(I can also wire this up so you preview it live online — see Deploy below.)

## What works right now

- Map with clustered pins (green = normal, amber = featured or happening soon).
- Event list beside the map; click a card to fly to its pin.
- Filters: search box, type, country, **month**, and a "Soon (next 14 days)" toggle.
- Dreamy/playful theme (flowing shapes, soft gradients, Fraunces + Quicksand fonts) and a softer painterly map (CARTO Voyager).
- Past events are hidden automatically.
- Featured events sort to the top and get an amber border (this is how paid
  highlighting will work later — just set `"featured": true` on an event).
- Facilitators gallery tab.
- Contribute / report-an-error form (needs a 2-minute connection step, below).

## Connect the contribute form (before launch)

The form is pre-built but not yet pointed at an inbox. Two free options:

- **Formspree:** make a free form at formspree.io, copy your form ID, and in
  `index.html` replace `YOUR_FORM_ID` in the form's `action="…"` line.
- **Netlify Forms:** if you deploy on Netlify, add `netlify` to the `<form>` tag
  and submissions show up in your Netlify dashboard — no code.

Until then, the form politely tells submitters it isn't connected (nothing is lost).

## The map style (Stamen Watercolor)

The map uses the painterly **Stamen Watercolor** basemap (hosted by Stadia Maps),
with a soft labels layer on top so city names show.

- **Local preview:** works immediately, no account needed.
- **Before going live:** create a free account at stadiamaps.com → add your
  domain (`otterotter.org`) to the property's allowlist. No code change — the
  tiles just start working on the live site. Free tier covers ~200k loads/month.
- If tiles ever look blank on the live site, the domain allowlist step is the fix.

## Editing the data by hand

Open `data/events.json` and copy an existing event block. Required fields:
`id` (unique), `title`, `type` (jam/class/workshop/festival/retreat),
`start_date` (YYYY-MM-DD), `city`, `country`, `lat`, `lng`, `link`.
`lat`/`lng` are map coordinates — Phase 2 (Telegram pipeline) fills these in
automatically; for manual entries you can grab them from Google Maps (right-click
a spot → the numbers at the top).

## Deploy it online (when ready — Phase 0)

Easiest free path:
1. Put this `site/` folder in a GitHub repository.
2. Connect the repo to **Netlify** (or Vercel) — it auto-publishes on every change.
3. Point your domain **www.otterotter.org** at it (Netlify gives step-by-step DNS).

I'll walk you through each click when you're ready.

## What's next (from the plan)

- **Phase 2:** Telegram → AI extraction → approval queue → auto-updates `events.json`.
- **Phase 3:** richer facilitator profiles + form routing.
- **Phase 4:** paid highlighting checkout + route planner.
