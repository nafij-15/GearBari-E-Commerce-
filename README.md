<<<<<<< HEAD
# GearBari — Run Locally

This is your original GearBari project (Express + MongoDB + vanilla JS/Bootstrap
frontend) with a full visual redesign. All features, routes, and the database
schema are untouched — only `public/index.html`, `public/style.css`, and a
couple of class names in `public/app.js` changed.

## 1. Install dependencies
```bash
npm install
```

## 2. Make sure MongoDB is reachable
Your `.env` file already has your `MONGO_URI` (defaults to
`mongodb://127.0.0.1:27017/gearbari` if unset). If you use local MongoDB,
just make sure it's running before starting the server.

## 3. Start the server
```bash
npm start
```
or, for auto-reload while you edit:
```bash
npm run dev
```

## 4. Open it
Visit **http://localhost:5000** (or whatever `PORT` is set to in `.env`).

The database auto-seeds 20 sample products the first time it connects to an
empty database, so the storefront won't be empty on first run.

## What changed visually
- New "hardware HUD" design system: near-black background, PCB-style clipped
  corners, mono spec-sheet typography, targeting-bracket hover effects on
  product cards, and a pulsing LED tied to the real-time stock indicator.
- New fonts: Space Grotesk (headings), Inter (body), JetBrains Mono (data/prices).
- A ticker-style top banner, a new hero intro section, and a footer — all
  purely additive, nothing functional was removed.
- Every button, modal, table, tab, and form still uses the same IDs/classes
  Bootstrap and your existing `app.js` logic depend on — so all functionality
  (cart, checkout, login/register, invoices, admin dashboard, live stock
  polling, etc.) works exactly as before.
=======
# GearBari-E-Commerce-
An E-Commerece with Real-time MongoDB database support I've created as a project while I was learning nodeJS,HTML5,JavaScript
>>>>>>> 4f7cd74a15c3a200772f215fe22b55e91e27019e
