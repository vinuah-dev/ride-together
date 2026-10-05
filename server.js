const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

// `node server.js --lan` serves HTTPS with a self-signed certificate so phones on the
// same WiFi can share their location (browsers only allow GPS on HTTPS pages).
const LAN_MODE = process.argv.includes('--lan');

const app = express();
const io = new Server();

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(PUBLIC_DIR));

const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#eab308'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const CODE_RE = /^[A-Z2-9]{6}$/;
const PING_KINDS = new Set(['fuel', 'chai', 'wait', 'regroup', 'sos']);
const TRAIL_MAX = 400;
const TRAIL_MIN_STEP_KM = 0.015;
const RIDE_TTL_MS = 24 * 60 * 60 * 1000;

// Host tokens are an HMAC of the ride code, so they keep working after a restart as long as
// RIDE_SECRET stays the same (Render generates it, see render.yaml).
const RIDE_SECRET = process.env.RIDE_SECRET || crypto.randomBytes(32).toString('hex');
const hostToken = (id) => crypto.createHmac('sha256', RIDE_SECRET).update(id).digest('base64url');
function isHost(id, token) {
  const a = Buffer.from(hostToken(id));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Rides the host ended, so old share links can't bring them back. id -> endedAt
const endedRides = new Map();

// In-memory store. rides: code -> ride
// ride = { id, name, destination, members: Map<memberId, member>, conns: Map<memberId, count>, lastActive }
const rides = new Map();

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (rides.has(code));
  return code;
}

function cleanDestination(d) {
  if (!d) return null;
  const lat = num(d.lat);
  const lng = num(d.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, label: str(d.label, 200) || `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
}

function createRide(id, name, destination) {
  const ride = {
    id,
    name: str(name, 60) || 'Group Ride',
    destination: cleanDestination(destination),
    members: new Map(),
    conns: new Map(),
    lastActive: Date.now(),
  };
  rides.set(id, ride);
  return ride;
}

function memberView(m, withTrail = false) {
  const { trail, ...rest } = m;
  return withTrail ? { ...rest, trail } : rest;
}

function rideView(ride, withTrails = false) {
  return {
    id: ride.id,
    name: ride.name,
    destination: ride.destination,
    members: [...ride.members.values()].map((m) => memberView(m, withTrails)),
  };
}

function pickColor(ride) {
  const used = new Set([...ride.members.values()].map((m) => m.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[ride.members.size % COLORS.length];
}

app.post('/api/rides', (req, res) => {
  const { name, destination } = req.body || {};
  const ride = createRide(newCode(), name, destination);
  res.json({ id: ride.id, hostToken: hostToken(ride.id) });
});

app.get('/api/rides/:id', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  if (endedRides.has(id)) return res.status(410).json({ error: 'ended' });
  const ride = rides.get(id);
  if (!ride) return res.status(404).json({ error: 'Ride not found' });
  res.json(rideView(ride));
});

app.get('/r/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'ride.html')));

// ---------- Google Maps share links -> coordinates ----------
// Many small places (farms, resorts) are missing from OpenStreetMap search, so riders can
// paste a Google Maps link instead. Only Google Maps hosts are fetched.
const MAP_LINK_HOST = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|(www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?)$/i;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function coordsFromUrl(href) {
  let s = href;
  try { s = decodeURIComponent(href); } catch { /* keep raw */ }
  const patterns = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // exact place pin
    /[?&](?:q|query|ll|destination|daddr|center)=(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/,
    /\/(?:place|search|dir)\/(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/, // map centre, least precise
  ];
  for (const re of patterns) {
    const m = s.match(re);
    const c = m && validCoords(parseFloat(m[1]), parseFloat(m[2]));
    if (c) return c;
  }
  return null;
}

function placeNameFromUrl(u) {
  const m = u.pathname.match(/\/place\/([^/]+)/);
  const raw = m ? m[1] : u.searchParams.get('q') || u.searchParams.get('query');
  if (!raw) return '';
  const name = decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
  return /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(name) ? '' : name;
}

async function lookupPlace(name) {
  const res = await fetch(`https://www.google.com/maps?output=embed&hl=en&q=${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-IN,en' },
    signal: AbortSignal.timeout(8000),
  });
  const html = await res.text();
  // The embed page lists the matched place as  "<address>",[lat,lng],"<id>"],"<name>"
  const m = html.match(/"([^"]{3,300})",\[(-?\d+\.\d+),(-?\d+\.\d+)\],"\d+"\],"([^"]{1,200})"/);
  if (!m) return null;
  const c = validCoords(parseFloat(m[2]), parseFloat(m[3]));
  if (!c) return null;
  const address = m[1];
  const title = m[4];
  return { ...c, label: address.startsWith(title) ? address : `${title}, ${address}` };
}

app.get('/api/resolve-link', async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.url || '').trim());
  } catch {
    return res.status(400).json({ error: 'That is not a link' });
  }
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (!/^https?:$/.test(url.protocol) || !MAP_LINK_HOST.test(url.hostname)) {
        return res.status(400).json({ error: 'Only Google Maps links are supported' });
      }
      const c = coordsFromUrl(url.href);
      if (c) return res.json({ ...c, label: placeNameFromUrl(url) || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` });
      const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) });
      const next = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && next) {
        url = new URL(next, url);
        continue;
      }
      break;
    }
    const name = placeNameFromUrl(url);
    const place = name && (await lookupPlace(name));
    if (place) return res.json(place);
  } catch { /* fall through */ }
  res.status(404).json({ error: 'Could not find a location in that link' });
});

app.get('/healthz', (req, res) => res.json({ ok: true, rides: rides.size }));

io.on('connection', (socket) => {
  let ride = null;
  let memberId = null;
  let lastLocationAt = 0;

  function detach() {
    if (!ride || !memberId) return;
    const left = (ride.conns.get(memberId) || 1) - 1;
    if (left > 0) ride.conns.set(memberId, left);
    else ride.conns.delete(memberId);
    socket.leave(ride.id);
    return left;
  }

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const id = str(payload?.rideId, 6).toUpperCase();
    if (endedRides.has(id)) return reply({ error: 'ended' });
    let target = rides.get(id);

    // Server restarted / ride expired: rebuild it from the info carried in the share link.
    if (!target && CODE_RE.test(id) && payload?.seed) {
      target = createRide(id, payload.seed.name, payload.seed.destination);
    }
    if (!target) return reply({ error: 'not_found' });

    if (ride) detach();
    ride = target;
    memberId = str(payload?.memberId, 40) || socket.id;

    const existing = ride.members.get(memberId);
    const member = existing || {
      id: memberId,
      color: pickColor(ride),
      lat: null,
      lng: null,
      speed: null,
      heading: null,
      accuracy: null,
      updated: null,
      trail: [],
    };
    member.name = str(payload?.name, 30) || 'Rider';
    member.host = isHost(ride.id, payload?.hostToken);
    member.online = true;
    member.sharing = payload?.sharing !== false;
    ride.members.set(memberId, member);
    ride.conns.set(memberId, (ride.conns.get(memberId) || 0) + 1);
    ride.lastActive = Date.now();

    socket.join(ride.id);
    reply({ ride: rideView(ride, true), me: memberId });
    socket.to(ride.id).emit('member', memberView(member));
  });

  socket.on('location', (p) => {
    const m = ride?.members.get(memberId);
    if (!m || !p) return;
    const now = Date.now();
    if (now - lastLocationAt < 1000) return; // simple flood guard
    const lat = num(p.lat);
    const lng = num(p.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    lastLocationAt = now;

    const last = m.trail[m.trail.length - 1];
    if (!last || distanceKm(last, [lat, lng]) >= TRAIL_MIN_STEP_KM) {
      m.trail.push([lat, lng]);
      if (m.trail.length > TRAIL_MAX) m.trail.splice(0, m.trail.length - TRAIL_MAX);
    }
    Object.assign(m, {
      lat,
      lng,
      speed: num(p.speed),
      heading: num(p.heading),
      accuracy: num(p.accuracy),
      updated: now,
      online: true,
      sharing: true,
    });
    ride.lastActive = now;
    io.to(ride.id).emit('member', memberView(m));
  });

  socket.on('sharing', (on) => {
    const m = ride?.members.get(memberId);
    if (!m) return;
    m.sharing = !!on;
    io.to(ride.id).emit('member', memberView(m));
  });

  socket.on('destination', (d) => {
    if (!ride || !ride.members.has(memberId)) return;
    const dest = cleanDestination(d);
    if (!dest) return;
    ride.destination = dest;
    ride.lastActive = Date.now();
    io.to(ride.id).emit('destination', { destination: dest, by: ride.members.get(memberId).name });
  });

  socket.on('ping', (kind) => {
    const m = ride?.members.get(memberId);
    if (!m || !PING_KINDS.has(kind)) return;
    io.to(ride.id).emit('ping', { kind, from: m.id, name: m.name, color: m.color, lat: m.lat, lng: m.lng, at: Date.now() });
  });

  // Only the ride's creator (holder of the host token) can end it for everyone.
  socket.on('end', (token) => {
    if (!ride || !isHost(ride.id, token)) return;
    const id = ride.id;
    const by = ride.members.get(memberId)?.name || 'The host';
    io.to(id).emit('ended', { by });
    io.in(id).socketsLeave(id);
    rides.delete(id);
    endedRides.set(id, Date.now());
    ride = null;
  });

  socket.on('leave', () => {
    if (!ride || !ride.members.has(memberId)) return;
    detach();
    ride.members.delete(memberId);
    ride.conns.delete(memberId);
    io.to(ride.id).emit('left', memberId);
    ride = null;
  });

  socket.on('disconnect', () => {
    const m = ride?.members.get(memberId);
    if (!m) return;
    if (detach() > 0) return; // still connected from another tab
    m.online = false;
    io.to(ride.id).emit('member', memberView(m));
  });
});

setInterval(() => {
  const cutoff = Date.now() - RIDE_TTL_MS;
  for (const [id, ride] of rides) if (ride.lastActive < cutoff) rides.delete(id);
  for (const [id, at] of endedRides) if (at < cutoff) endedRides.delete(id);
}, 60 * 60 * 1000).unref();

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

// Self-signed certificate for localhost + this PC's LAN IPs, cached in .cert/ and
// regenerated when the IPs change.
async function lanCertificate(ips) {
  const file = path.join(__dirname, '.cert', 'lan.json');
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.ips.join() === ips.join() && new Date(cached.expires) > new Date()) return cached;
  } catch { /* no usable cached certificate */ }

  const selfsigned = require('selfsigned');
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Ride Together (local)' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: expires,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))] },
    ],
  });
  const cert = { key: pems.private, cert: pems.cert, ips, expires };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cert));
  return cert;
}

async function main() {
  if (!LAN_MODE) {
    const server = http.createServer(app);
    io.attach(server);
    const port = process.env.PORT || 3000;
    server.listen(port, () => console.log(`Ride Together running on http://localhost:${port}`));
    return;
  }

  const ips = lanAddresses();
  const { key, cert } = await lanCertificate(ips);
  const server = https.createServer({ key, cert }, app);
  io.attach(server);
  const port = process.env.PORT || 3443;
  server.listen(port, '0.0.0.0', () => {
    console.log('\nRide Together — WiFi test mode (HTTPS)\n');
    console.log(`  This PC:            https://localhost:${port}`);
    ips.forEach((ip) => console.log(`  Phone (same WiFi):  https://${ip}:${port}`));
    console.log('\n  The browser will warn "Your connection is not private" (self-signed certificate).');
    console.log('  Tap Advanced -> Proceed. That is expected for local testing.\n');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
