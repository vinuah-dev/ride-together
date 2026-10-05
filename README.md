# 🏍️ Ride Together

Mark a destination, share one link, and everyone in the group shows up live on the same map.

- **Create a ride**: name it, search or tap the 🏁 destination, get a link and a 6-letter code.
- **Place not found?** Paste a Google Maps share link (or `lat, lng`) into the search box. Saved places (`SAVED_PLACES` in `public/common.js`) show as one-tap chips, and the first one is pre-selected.
- **Share**: one tap for WhatsApp, copy, or the phone's share sheet.
- **Live map**: every rider's position, direction, speed and trail, updated every few seconds.
- **Who's where**: road distance and ETA to the destination, who's leading and how far behind each rider is.
- **Quick alerts**: ✋ Wait · ☕ Chai · ⛽ Fuel · 📍 Regroup · 🆘 SOS (beep and vibrate on friends' phones).
- **Navigate**: opens Google Maps to the destination or to a friend.
- Anyone can change the destination, pause their location, or leave.
- No sign-up and no API keys. It uses OpenStreetMap (map), Photon (search) and OSRM (routes).

## Run it on your computer

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Use it with friends (phones)

**Phones only share location over HTTPS**, so `http://192.168.x.x:3000` will not work on a phone. Use one of these:

### Same WiFi — quick local test

```bash
npm run lan
```

It starts HTTPS on port 3443 with a self-signed certificate and prints the links (`https://localhost:3443` for this PC, `https://<your-pc-ip>:3443` for phones on the same WiFi). Browsers warn "Your connection is not private". Tap **Advanced → Proceed**, which is expected for local testing.

### Option A — deploy free on Render (permanent link)

1. Push this folder to a GitHub repo.
2. On https://render.com, go to **New → Blueprint** and pick the repo. `render.yaml` already has the settings (free Node web service, `npm install` / `npm start`).
3. You get a link like `https://ride-together-xxxx.onrender.com`. Share rides from there.

> Free Render instances sleep after about 15 minutes of no traffic, so the first open takes around 30 seconds.
> Rides are kept in memory, but the share link also carries the ride name and destination. If the server restarts, opening the link rebuilds the ride automatically.

### Option B — quick tunnel from your PC (for testing)

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints an `https://….trycloudflare.com` link. Open that link and create the ride there.

## Good to know

- Keep the ride page open on screen while riding. Phones pause GPS for browser tabs in the background or when the screen locks. The page asks the phone to keep the screen awake.
- Rides with no activity are deleted after 24 hours.

## Files

| File | What it does |
|---|---|
| `server.js` | Express + Socket.io server: rides, members, live location relay, alerts |
| `public/index.html`, `home.js` | Create a ride / join with a code |
| `public/ride.html`, `ride.js` | Live map page |
| `public/common.js` | Map, search, distance and share helpers |
| `public/style.css` | Styles |
