// Helpers shared by the home page and the ride page.

const $ = (id) => document.getElementById(id);

function createMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: true, ...opts }).setView([22.5, 79], 5); // India
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return map;
}

function uniq(parts) {
  const seen = new Set();
  return parts.filter((p) => p && !seen.has(p) && seen.add(p));
}

// Place search: Photon (built for search-as-you-type), falling back to Nominatim.
async function searchPlaces(q, near) {
  try {
    const u = new URL('https://photon.komoot.io/api/');
    u.searchParams.set('q', q);
    u.searchParams.set('limit', '6');
    if (near) {
      u.searchParams.set('lat', near.lat.toFixed(4));
      u.searchParams.set('lon', near.lng.toFixed(4));
    }
    const res = await fetch(u);
    if (!res.ok) throw new Error('photon ' + res.status);
    const data = await res.json();
    const seen = new Set();
    return data.features.map((f) => {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      const street = p.street && (p.housenumber ? `${p.street} ${p.housenumber}` : p.street);
      const label = uniq([p.name, street, p.district, p.city, p.state, p.country]).join(', ');
      return { lat, lng, label };
    }).filter((r) => !seen.has(r.label) && seen.add(r.label));
  } catch {
    const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q));
    const data = await res.json();
    return data.map((p) => ({ lat: +p.lat, lng: +p.lon, label: p.display_name }));
  }
}

async function reverseGeocode(lat, lng) {
  const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`);
    const data = await res.json();
    const p = data.features?.[0]?.properties;
    if (!p) return fallback;
    const street = p.street && (p.housenumber ? `${p.street} ${p.housenumber}` : p.street);
    return uniq([p.name, street, p.district, p.city, p.state]).join(', ') || fallback;
  } catch {
    return fallback;
  }
}

// Places the group uses often. They show as one-tap chips, and the first one is the default destination.
const SAVED_PLACES = [
  {
    name: 'Starlight House, Goyal Farms',
    lat: 21.2696694,
    lng: 78.7852284,
    label: 'Starlight House by Goyal Farms and Resorts, 105, beside Ambika Farms, behind IMT College, Dorli (Bk), Maharashtra 441502',
  },
];

function renderSavedChips(container, onPick) {
  container.innerHTML = '';
  SAVED_PLACES.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `⭐ ${p.name}`;
    b.title = p.label;
    b.addEventListener('click', () => onPick({ lat: p.lat, lng: p.lng, label: p.label }));
    container.appendChild(b);
  });
}

// "21.2696, 78.7852" typed or pasted as a destination
function parseCoords(q) {
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` } : null;
}

async function resolveMapLink(q) {
  const res = await fetch('/api/resolve-link?url=' + encodeURIComponent(q));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not read that link');
  return data;
}

// Debounced search box: input + <ul> of results -> onPick({lat, lng, label}).
// Accepts place names, "lat, lng", or a pasted Google Maps link.
function wireSearch(input, list, onPick, getNear) {
  let timer = null;
  let seq = 0;
  let results = [];

  const close = () => { list.innerHTML = ''; list.classList.remove('open'); };
  const pick = (r) => { close(); input.value = r.label; input.blur(); onPick(r); };

  async function lookup(q) {
    const coords = parseCoords(q);
    if (coords) return { results: [coords] };
    if (/^https?:\/\/|^(maps\.app\.goo\.gl|goo\.gl|maps\.google|www\.google)/i.test(q)) {
      try {
        return { results: [await resolveMapLink(/^https?:/i.test(q) ? q : `https://${q}`)] };
      } catch (err) {
        return { results: [], message: err.message };
      }
    }
    return { results: await searchPlaces(q, getNear && getNear()).catch(() => []) };
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      list.innerHTML = '<li class="muted">Searching…</li>';
      list.classList.add('open');
      const found = await lookup(q);
      results = found.results;
      if (mine !== seq) return;
      list.innerHTML = '';
      if (!results.length) {
        list.innerHTML = `<li class="muted">${escapeHtml(found.message || 'No places found.')}<span>Tip: in Google Maps tap Share → Copy link, then paste it here.</span></li>`;
      }
      results.forEach((r) => {
        const li = document.createElement('li');
        const [head, ...rest] = r.label.split(', ');
        li.innerHTML = `<strong>${escapeHtml(head)}</strong><span>${escapeHtml(rest.join(', '))}</span>`;
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so blur doesn't close first
        li.addEventListener('click', () => pick(r));
        list.appendChild(li);
      });
    }, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (results[0]) pick(results[0]); }
    if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function fmtKm(km) {
  if (km == null || !isFinite(km)) return '–';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  const min = Math.round(sec / 60);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} m`;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function toast(msg, { type = '', ms = 3000, color } = {}) {
  let wrap = $('toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toasts';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  if (color) t.style.borderLeftColor = color;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

const destIcon = L.divIcon({
  className: 'dest-icon',
  html: '<div class="dest-pin"><span>🏁</span></div>',
  iconSize: [44, 52],
  iconAnchor: [22, 50],
});

function shareUrl(id, name, dest) {
  const q = new URLSearchParams();
  if (name) q.set('n', name);
  if (dest) q.set('to', `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`);
  return `${location.origin}/r/${id}${q.toString() ? '?' + q : ''}`;
}

function shareText(name, dest) {
  return `🏍️ Join "${name}" on Ride Together!${dest ? `\n🏁 Destination: ${dest.label}` : ''}\nOpen the link to see everyone live on the map 👇`;
}

function whatsappHref(text, url) {
  return 'https://wa.me/?text=' + encodeURIComponent(`${text}\n${url}`);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Link copied ✅');
}

async function nativeShare(title, text, url) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); } catch { /* cancelled */ }
    return true;
  }
  return false;
}

function navigateHref(dest) {
  return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
}
