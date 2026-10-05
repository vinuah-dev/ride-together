(() => {
  const rideId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
  const params = new URLSearchParams(location.search);

  const memberId = (() => {
    let id = localStorage.getItem('rt_member');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem('rt_member', id);
    }
    return id;
  })();

  const PINGS = {
    wait: ['✋', 'Wait for me!'],
    chai: ['☕', 'Chai break?'],
    fuel: ['⛽', 'Need a fuel stop'],
    regroup: ['📍', "Let's regroup here"],
    sos: ['🆘', 'SOS — needs help!'],
  };
  const ARRIVED_KM = 0.2;
  const ROUTE_COLOR = '#2563eb';

  const state = {
    ride: null,
    joined: false,
    members: new Map(), // id -> member (without trail)
    layers: new Map(),  // id -> { marker, trail, iconKey }
    myPos: null,
    lastSent: 0,
    sharing: true,
    showTrails: localStorage.getItem('rt_trails') !== 'off',
    roads: new Map(),   // id -> { distance, duration, from }  (OSRM table, road distance to destination)
    myRoute: null,      // { distance, duration, from, destKey, at }
    routeBusy: false,
    tableAt: 0,
    arrived: false,
    picking: false,
    fitted: false,
    feed: [],
  };

  const map = createMap('map');
  let destMarker = null;
  let routeLine = null;
  let accuracyCircle = null;
  let watchId = null;
  let wakeLock = null;
  const socket = io({ autoConnect: false });

  // ---------- helpers ----------
  const hasPos = (m) => m && m.lat != null && m.lng != null;
  const isMe = (m) => m.id === memberId;
  const dest = () => state.ride?.destination || null;
  const destKey = (d) => (d ? `${d.lat},${d.lng}` : '');

  function seed() {
    const name = params.get('n') || '';
    let destination = null;
    const to = params.get('to');
    if (to) {
      const [lat, lng] = to.split(',').map(Number);
      if (isFinite(lat) && isFinite(lng)) destination = { lat, lng, label: '' };
    }
    return { name, destination };
  }

  function currentShareUrl() {
    return shareUrl(rideId, state.ride?.name, dest());
  }

  function syncUrl() {
    const u = new URL(currentShareUrl());
    history.replaceState(null, '', u.pathname + u.search);
  }

  // Road distance measured from an older position, corrected for how far the rider has moved since.
  function adjustedRoad(road, now, d) {
    const moved = distanceKm(road.from, d) - distanceKm(now, d);
    const straight = distanceKm(now, d);
    const km = Math.max(straight, road.distance / 1000 - moved);
    const ratio = road.distance > 0 ? km / (road.distance / 1000) : 1;
    return { km, eta: road.duration * ratio, road: true };
  }

  function remainingFor(m) {
    const d = dest();
    if (!d || !hasPos(m)) return null;
    if (isMe(m) && state.myRoute && !state.myRoute.failed && state.myRoute.destKey === destKey(d)) {
      return adjustedRoad(state.myRoute, m, d);
    }
    const r = state.roads.get(m.id);
    if (r && r.destKey === destKey(d)) return adjustedRoad(r, m, d);
    return { km: distanceKm(m, d), eta: null, road: false };
  }

  function statusLine(m) {
    if (!m.online) return `Offline · last seen ${timeAgo(m.updated)}`;
    if (m.sharing === false) return 'Location paused';
    if (!hasPos(m)) return 'Waiting for GPS…';
    const d = dest();
    if (d && distanceKm(m, d) <= ARRIVED_KM) return '🏁 Reached destination';
    const parts = [];
    if (m.speed != null) parts.push(`${Math.round(m.speed * 3.6)} km/h`);
    parts.push(`updated ${timeAgo(m.updated)}`);
    return parts.join(' · ');
  }

  // ---------- map rendering ----------
  function pinHtml(m) {
    const off = !m.online || m.sharing === false;
    const showDir = m.heading != null && m.speed != null && m.speed > 1;
    return `
      <div class="pin ${isMe(m) ? 'me' : ''} ${off ? 'off' : ''}" style="--c:${m.color}">
        ${showDir ? `<div class="dir" style="transform:rotate(${Math.round(m.heading)}deg)"></div>` : ''}
        <span>${escapeHtml(initials(m.name))}</span>
      </div>
      <div class="pin-label">${escapeHtml(isMe(m) ? 'You' : m.name)}</div>`;
  }

  function renderMember(m) {
    let layer = state.layers.get(m.id);
    if (!hasPos(m)) return;
    const iconKey = [m.name, m.color, m.online, m.sharing, m.speed != null && m.speed > 1 ? Math.round(m.heading / 10) : 'x'].join('|');
    if (!layer) {
      const marker = L.marker([m.lat, m.lng], {
        icon: L.divIcon({ className: 'pin-wrap', html: pinHtml(m), iconSize: [38, 38], iconAnchor: [19, 19] }),
        zIndexOffset: isMe(m) ? 1000 : 0,
      }).addTo(map);
      marker.on('click', () => focusMember(m.id));
      const trail = L.polyline([], { color: m.color, weight: 4, opacity: 0.55, lineCap: 'round' });
      if (state.showTrails) trail.addTo(map);
      layer = { marker, trail, iconKey };
      state.layers.set(m.id, layer);
    } else {
      layer.marker.setLatLng([m.lat, m.lng]);
      if (layer.iconKey !== iconKey) {
        layer.marker.setIcon(L.divIcon({ className: 'pin-wrap', html: pinHtml(m), iconSize: [38, 38], iconAnchor: [19, 19] }));
        layer.iconKey = iconKey;
      }
    }
    // Extend the trail the same way the server does (ignore GPS jitter under ~15 m).
    const pts = layer.trail.getLatLngs();
    const last = pts[pts.length - 1];
    if (!last || distanceKm({ lat: last.lat, lng: last.lng }, m) >= 0.015) layer.trail.addLatLng([m.lat, m.lng]);
  }

  function removeMemberLayers(id) {
    const layer = state.layers.get(id);
    if (!layer) return;
    layer.marker.remove();
    layer.trail.remove();
    state.layers.delete(id);
  }

  function renderDestination() {
    const d = dest();
    if (!d) {
      destMarker?.remove();
      destMarker = null;
      $('destName').textContent = 'Not set yet — tap “Change destination”';
      $('navBtn').classList.add('hidden');
      return;
    }
    if (!destMarker) destMarker = L.marker([d.lat, d.lng], { icon: destIcon, zIndexOffset: 500 }).addTo(map);
    else destMarker.setLatLng([d.lat, d.lng]);
    destMarker.unbindTooltip().bindTooltip(escapeHtml(d.label), { direction: 'top', offset: [0, -48] });
    $('destName').textContent = d.label;
    $('destName').title = d.label;
    $('navBtn').href = navigateHref(d);
    $('navBtn').classList.remove('hidden');
  }

  function focusMember(id) {
    const m = state.members.get(id);
    if (!hasPos(m)) return toast(`${m?.name || 'Rider'} has no location yet`);
    map.flyTo([m.lat, m.lng], Math.max(map.getZoom(), 15), { duration: 0.7 });
    const rem = remainingFor(m);
    const html = `
      <div class="popup">
        <strong style="color:${m.color}">${escapeHtml(isMe(m) ? `${m.name} (You)` : m.name)}</strong>
        <div>${escapeHtml(statusLine(m))}</div>
        ${rem ? `<div>${rem.road ? '' : '≈ '}${fmtKm(rem.km)} to destination</div>` : ''}
        ${isMe(m) ? '' : `<a target="_blank" rel="noopener" href="${navigateHref(m)}">Navigate to ${escapeHtml(m.name)} →</a>`}
      </div>`;
    L.popup({ offset: [0, -14] }).setLatLng([m.lat, m.lng]).setContent(html).openOn(map);
  }

  function fitAll() {
    const pts = [...state.members.values()].filter(hasPos).map((m) => [m.lat, m.lng]);
    const d = dest();
    if (d) pts.push([d.lat, d.lng]);
    if (!pts.length) return false;
    // On phones the bottom sheet covers part of the map, so keep markers above it.
    const sheet = $('sheet');
    const covered = window.innerWidth < 900 ? sheet.offsetHeight : 0;
    map.fitBounds(pts.length === 1 ? L.latLng(pts[0]).toBounds(2000) : pts, {
      paddingTopLeft: [50, 60],
      paddingBottomRight: [60, covered + 40],
      maxZoom: 15,
    });
    return true;
  }

  // ---------- panel rendering ----------
  function renderHeader() {
    const all = [...state.members.values()];
    const online = all.filter((m) => m.online).length;
    $('rideTitle').textContent = state.ride?.name || 'Ride Together';
    document.title = `${state.ride?.name || 'Ride'} · Ride Together`;
    $('rideSub').textContent = socket.connected
      ? `${online} online · ${all.length} rider${all.length === 1 ? '' : 's'} · ${rideId}`
      : 'Reconnecting…';
    $('connDot').classList.toggle('ok', socket.connected);
    $('riderCount').textContent = all.length;
    $('handleLabel').textContent = `${all.length} rider${all.length === 1 ? '' : 's'} · more`;
  }

  function renderStats() {
    const me = state.members.get(memberId);
    const rem = remainingFor(me && hasPos(me) ? me : state.myPos ? { ...state.myPos, id: memberId } : null);
    $('statDist').textContent = rem ? `${rem.road ? '' : '≈'}${fmtKm(rem.km)}` : '–';
    $('statEta').textContent = rem && rem.eta != null ? fmtDuration(rem.eta) : '–';
    const speed = state.myPos?.speed;
    $('statSpeed').textContent = speed != null ? Math.round(speed * 3.6) : '–';

    if (rem && rem.km <= ARRIVED_KM && !state.arrived) {
      state.arrived = true;
      toast("🏁 You've reached the destination!", { ms: 5000 });
    }
  }

  function renderList() {
    const rows = [...state.members.values()].map((m) => ({ m, rem: remainingFor(m) }));
    rows.sort((a, b) => {
      if (a.m.online !== b.m.online) return a.m.online ? -1 : 1;
      return (a.rem?.km ?? Infinity) - (b.rem?.km ?? Infinity) || a.m.name.localeCompare(b.m.name);
    });
    const leader = rows.find((r) => r.rem && r.m.online && r.m.sharing !== false);
    const ul = $('riders');
    ul.innerHTML = rows
      .map(({ m, rem }) => {
        const gap = leader && rem && leader.m.id !== m.id ? rem.km - leader.rem.km : null;
        const off = !m.online || m.sharing === false;
        return `
        <li class="rider ${off ? 'off' : ''}" data-id="${escapeHtml(m.id)}">
          <div class="avatar" style="--c:${m.color}">${escapeHtml(initials(m.name))}</div>
          <div class="rider-info">
            <div class="rider-name">${escapeHtml(m.name)}
              ${isMe(m) ? '<span class="tag">You</span>' : ''}
              ${leader && leader.m.id === m.id && rows.length > 1 ? '<span class="tag lead">🏆 Leading</span>' : ''}
            </div>
            <div class="rider-meta">${escapeHtml(statusLine(m))}</div>
          </div>
          <div class="rider-dist">
            ${rem ? `<strong>${rem.road ? '' : '≈'}${fmtKm(rem.km)}</strong>` : ''}
            ${gap != null && gap > 0.05 ? `<small>+${fmtKm(gap)} behind</small>` : ''}
          </div>
        </li>`;
      })
      .join('');
  }

  function renderAll() {
    renderHeader();
    renderStats();
    renderList();
  }

  function addFeed(text) {
    state.feed.unshift({ text, at: Date.now() });
    state.feed = state.feed.slice(0, 12);
    $('feed').innerHTML = state.feed
      .map((f) => `<li><span>${escapeHtml(f.text)}</span><time>${new Date(f.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>`)
      .join('');
  }

  // ---------- routing (OSRM public server; falls back to straight-line distance) ----------
  async function refreshMyRoute(force = false) {
    const d = dest();
    const p = state.myPos;
    if (!d || !p) {
      routeLine?.remove();
      routeLine = null;
      return;
    }
    const r = state.myRoute;
    const key = destKey(d);
    if (!force && r && r.destKey === key && Date.now() - r.at < 120000 && distanceKm(r.from, p) < 0.5) return;
    if (state.routeBusy) return;
    state.routeBusy = true;
    const from = { lat: p.lat, lng: p.lng };
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('no route');
      if (destKey(dest()) !== key) return; // destination changed meanwhile
      const route = data.routes[0];
      const latlngs = route.geometry.coordinates.map(([x, y]) => [y, x]);
      if (!routeLine) routeLine = L.polyline(latlngs, { color: ROUTE_COLOR, weight: 6, opacity: 0.7 }).addTo(map);
      else routeLine.setLatLngs(latlngs);
      routeLine.bringToBack();
      state.myRoute = { distance: route.distance, duration: route.duration, from, destKey: key, at: Date.now() };
    } catch {
      state.myRoute = { failed: true, from, destKey: key, at: Date.now() };
    } finally {
      state.routeBusy = false;
      renderStats();
      renderList();
    }
  }

  async function refreshRoads() {
    const d = dest();
    const ms = [...state.members.values()].filter((m) => hasPos(m) && !isMe(m) && m.online);
    if (!d || !ms.length || Date.now() - state.tableAt < 60000) return;
    state.tableAt = Date.now();
    const key = destKey(d);
    const coords = ms.map((m) => `${m.lng},${m.lat}`).concat(`${d.lng},${d.lat}`).join(';');
    const sources = ms.map((_, i) => i).join(';');
    try {
      const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?sources=${sources}&destinations=${ms.length}&annotations=distance,duration`);
      const data = await res.json();
      if (data.code !== 'Ok') return;
      ms.forEach((m, i) => {
        const distance = data.distances?.[i]?.[0];
        const duration = data.durations?.[i]?.[0];
        if (distance != null) state.roads.set(m.id, { distance, duration, from: { lat: m.lat, lng: m.lng }, destKey: key });
      });
      renderList();
    } catch { /* keep straight-line estimates */ }
  }

  // ---------- geolocation ----------
  function startGps() {
    if (watchId != null) return;
    if (!navigator.geolocation) return showGpsWarn('This browser cannot share location. You can still see everyone else.');
    if (!window.isSecureContext) return showGpsWarn('Location needs HTTPS. Open this site over https:// to share your location.');
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 30000,
    });
  }

  function showGpsWarn(msg) {
    $('gpsWarn').textContent = msg;
    $('gpsWarn').classList.toggle('hidden', !msg);
  }

  function onPosition(p) {
    const c = p.coords;
    const prev = state.myPos;
    let speed = c.speed != null && c.speed >= 0 ? c.speed : null;
    if (speed == null && prev) {
      const dt = (p.timestamp - prev.at) / 1000;
      if (dt > 0.5) speed = (distanceKm(prev, { lat: c.latitude, lng: c.longitude }) * 1000) / dt;
    }
    state.myPos = {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      heading: c.heading != null && !isNaN(c.heading) ? c.heading : null,
      speed,
      at: p.timestamp,
    };
    showGpsWarn(c.accuracy > 200 ? `Weak GPS signal (±${Math.round(c.accuracy)} m)` : '');

    // Draw my position right away instead of waiting for the server echo.
    const me = state.members.get(memberId);
    if (me && state.sharing) {
      Object.assign(me, state.myPos, { updated: Date.now(), online: true, sharing: true });
      renderMember(me);
    }
    if (!accuracyCircle) accuracyCircle = L.circle([c.latitude, c.longitude], { radius: c.accuracy, color: ROUTE_COLOR, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    else accuracyCircle.setLatLng([c.latitude, c.longitude]).setRadius(c.accuracy);

    if (!state.fitted && state.joined) state.fitted = fitAll();
    sendLocation();
    refreshMyRoute();
    renderStats();
  }

  function onPositionError(err) {
    if (err.code === err.PERMISSION_DENIED) {
      showGpsWarn('Location permission is blocked. Allow it in your browser settings so friends can see you.');
    } else {
      showGpsWarn('Looking for GPS signal…');
    }
  }

  function sendLocation(force = false) {
    const p = state.myPos;
    if (!p || !state.sharing || !socket.connected || !state.joined) return;
    const now = Date.now();
    if (!force && now - state.lastSent < 3000) return;
    state.lastSent = now;
    socket.emit('location', { lat: p.lat, lng: p.lng, speed: p.speed, heading: p.heading, accuracy: p.accuracy });
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch { /* not allowed, fine */ }
  }

  // ---------- alerts ----------
  let audioCtx = null;
  function beep(times = 1, freq = 880) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const t = audioCtx.currentTime + i * 0.22;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      }
    } catch { /* audio unavailable */ }
  }

  // Browsers only allow sound after a user gesture; unlock it on the first tap.
  document.addEventListener('pointerdown', () => { beep(0); audioCtx?.resume?.(); }, { once: true });

  // ---------- socket ----------
  function join() {
    state.sharing = localStorage.getItem(`rt_sharing_${rideId}`) !== 'off';
    socket.connect();
  }

  socket.on('connect', () => {
    socket.emit(
      'join',
      { rideId, memberId, name: localStorage.getItem('rt_name'), sharing: state.sharing, seed: seed() },
      (res) => {
        if (res?.error) {
          socket.disconnect();
          $('joinModal').classList.add('hidden');
          $('notFoundModal').classList.remove('hidden');
          return;
        }
        onJoined(res.ride);
      }
    );
  });

  socket.on('disconnect', () => renderHeader());

  function onJoined(ride) {
    const first = !state.joined;
    state.ride = { id: ride.id, name: ride.name, destination: ride.destination };
    // Server is the source of truth after a (re)connect.
    const seen = new Set();
    ride.members.forEach(({ trail, ...m }) => {
      seen.add(m.id);
      state.members.set(m.id, m);
      renderMember(m);
      const layer = state.layers.get(m.id);
      if (layer && trail?.length) layer.trail.setLatLngs(trail);
    });
    for (const id of [...state.members.keys()]) if (!seen.has(id)) { state.members.delete(id); removeMemberLayers(id); }

    state.joined = true;
    syncUrl();
    renderDestination();
    renderAll();
    updateShareToggle();

    if (first) {
      addFeed('You joined the ride');
      state.fitted = fitAll();
      if (!state.fitted && dest()) map.setView([dest().lat, dest().lng], 12);
      startGps();
      keepAwake();
      refreshRoads();
    }
    sendLocation(true);
  }

  socket.on('member', (m) => {
    const prev = state.members.get(m.id);
    if (!prev && !isMe(m)) {
      toast(`👋 ${m.name} joined`, { color: m.color });
      addFeed(`${m.name} joined`);
    } else if (prev && prev.online && !m.online && !isMe(m)) {
      addFeed(`${m.name} went offline`);
    } else if (prev && !prev.online && m.online && !isMe(m)) {
      addFeed(`${m.name} is back online`);
    }
    // Don't let a slightly older echo of my own position overwrite the fresher local GPS fix.
    if (isMe(m) && state.myPos && state.sharing) Object.assign(m, state.myPos);
    state.members.set(m.id, m);
    renderMember(m);
    renderAll();
  });

  socket.on('left', (id) => {
    const m = state.members.get(id);
    if (m) {
      toast(`${m.name} left the ride`);
      addFeed(`${m.name} left`);
    }
    state.members.delete(id);
    state.roads.delete(id);
    removeMemberLayers(id);
    renderAll();
  });

  socket.on('destination', ({ destination, by }) => {
    state.ride.destination = destination;
    state.arrived = false;
    state.tableAt = 0;
    state.roads.clear();
    renderDestination();
    syncUrl();
    toast(`🏁 ${by} set destination: ${destination.label}`, { ms: 4500 });
    addFeed(`${by} changed destination to ${destination.label}`);
    refreshMyRoute(true);
    refreshRoads();
    renderAll();
  });

  socket.on('ping', (p) => {
    const [emoji, text] = PINGS[p.kind] || ['📣', p.kind];
    const mine = p.from === memberId;
    const msg = `${emoji} ${mine ? 'You' : p.name}: ${text}`;
    addFeed(msg);
    if (mine) return toast(`Sent to everyone: ${emoji} ${text}`);
    if (p.kind === 'sos') {
      toast(msg, { type: 'sos', ms: 10000 });
      beep(4, 1200);
      navigator.vibrate?.([300, 100, 300, 100, 600]);
      if (p.lat != null) focusMember(p.from);
    } else {
      toast(msg, { color: p.color, ms: 5000 });
      beep(2);
      navigator.vibrate?.([150, 80, 150]);
    }
  });

  // ---------- UI wiring ----------
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModals() { document.querySelectorAll('.modal').forEach((m) => m.id !== 'notFoundModal' && m.id !== 'joinModal' && m.classList.add('hidden')); }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('joinName').value.trim();
    if (!name) return;
    localStorage.setItem('rt_name', name);
    $('joinModal').classList.add('hidden');
    beep(0); // unlock audio on this user gesture so alerts can play later
    join();
  });

  $('shareBtn').addEventListener('click', () => {
    const url = currentShareUrl();
    const text = shareText(state.ride?.name || 'our ride', dest());
    $('shareCode').textContent = rideId;
    $('shareLink').value = url;
    $('waBtn').href = whatsappHref(text, url);
    $('copyBtn').onclick = () => copyText(url);
    $('shareLink').onclick = (e) => e.target.select();
    $('nativeShareBtn').onclick = async () => { if (!(await nativeShare(state.ride?.name, text, url))) copyText(url); };
    openModal('shareModal');
  });

  $('meBtn').addEventListener('click', () => {
    if (state.myPos) map.flyTo([state.myPos.lat, state.myPos.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    else toast('Waiting for your GPS…');
  });
  $('fitBtn').addEventListener('click', () => fitAll() || toast('No one has a location yet'));
  $('destBtn').addEventListener('click', () => {
    const d = dest();
    if (d) map.flyTo([d.lat, d.lng], 15, { duration: 0.6 });
    else openModal('destModal');
  });

  $('riders').addEventListener('click', (e) => {
    const li = e.target.closest('.rider');
    if (li) {
      focusMember(li.dataset.id);
      if (window.innerWidth < 900) $('sheet').classList.add('collapsed');
    }
  });

  $('sheetHandle').addEventListener('click', () => $('sheet').classList.toggle('collapsed'));

  const pingCooldown = new Map();
  $('pings').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ping]');
    if (!btn || !state.joined) return;
    const kind = btn.dataset.ping;
    if (Date.now() - (pingCooldown.get(kind) || 0) < 5000) return toast('Easy, already sent 🙂');
    if (kind === 'sos' && !confirm('Send an SOS alert with your location to everyone in the ride?')) return;
    pingCooldown.set(kind, Date.now());
    socket.emit('ping', kind);
    btn.classList.add('sent');
    setTimeout(() => btn.classList.remove('sent'), 600);
  });

  // Destination change
  wireSearch($('destSearch'), $('destResults'), (r) => {
    closeModals();
    socket.emit('destination', r);
    $('destSearch').value = '';
  }, () => (map.getZoom() >= 8 ? map.getCenter() : null));
  renderSavedChips($('savedChips'), (r) => {
    closeModals();
    socket.emit('destination', r);
  });

  $('changeDestBtn').addEventListener('click', () => {
    openModal('destModal');
    setTimeout(() => $('destSearch').focus(), 50);
  });

  $('pickOnMapBtn').addEventListener('click', () => {
    closeModals();
    state.picking = true;
    $('pickBanner').classList.remove('hidden');
    $('sheet').classList.add('collapsed');
    map.getContainer().classList.add('picking');
  });

  function stopPicking() {
    state.picking = false;
    $('pickBanner').classList.add('hidden');
    map.getContainer().classList.remove('picking');
  }
  $('pickCancel').addEventListener('click', stopPicking);

  map.on('click', async (e) => {
    if (!state.picking) return;
    stopPicking();
    const { lat, lng } = e.latlng;
    const label = await reverseGeocode(lat, lng);
    if (confirm(`Set destination to:\n${label}?`)) socket.emit('destination', { lat, lng, label });
  });

  function updateShareToggle() {
    $('shareToggle').textContent = state.sharing ? '⏸ Pause my location' : '▶ Resume my location';
  }
  $('shareToggle').addEventListener('click', () => {
    state.sharing = !state.sharing;
    localStorage.setItem(`rt_sharing_${rideId}`, state.sharing ? 'on' : 'off');
    socket.emit('sharing', state.sharing);
    if (state.sharing) sendLocation(true);
    updateShareToggle();
    toast(state.sharing ? 'Sharing your location again' : 'Location paused — friends see your last spot');
  });

  function applyTrails() {
    for (const { trail } of state.layers.values()) {
      if (state.showTrails) trail.addTo(map);
      else trail.remove();
    }
    $('trailToggle').textContent = state.showTrails ? 'Hide trails' : 'Show trails';
  }
  $('trailToggle').addEventListener('click', () => {
    state.showTrails = !state.showTrails;
    localStorage.setItem('rt_trails', state.showTrails ? 'on' : 'off');
    applyTrails();
  });

  $('leaveBtn').addEventListener('click', () => {
    if (!confirm('Leave this ride? Friends will stop seeing you.')) return;
    socket.emit('leave');
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    setTimeout(() => (location.href = '/'), 200);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.joined) {
      keepAwake();
      sendLocation(true);
    }
  });

  window.addEventListener('resize', () => map.invalidateSize());

  // Periodic work: refresh "x min ago" labels, keep-alive location, road distances.
  setInterval(() => { if (state.joined) renderAll(); }, 5000);
  setInterval(() => { if (Date.now() - state.lastSent > 25000) sendLocation(true); }, 10000);
  setInterval(() => refreshRoads(), 15000);

  // ---------- boot ----------
  async function boot() {
    applyTrails();
    if (!/^[A-Z2-9]{6}$/.test(rideId)) return openModal('notFoundModal');

    let info = null;
    try {
      const res = await fetch(`/api/rides/${rideId}`);
      if (res.ok) info = await res.json();
    } catch { /* offline; the socket will retry */ }

    const s = seed();
    if (!info && !s.destination && !s.name) return openModal('notFoundModal');

    const name = info?.name || s.name || 'Group ride';
    const d = info?.destination || s.destination;
    $('rideTitle').textContent = name;
    if (d) {
      state.ride = { id: rideId, name, destination: { ...d, label: d.label || `${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}` } };
      renderDestination();
      map.setView([d.lat, d.lng], 11);
    }

    const savedName = localStorage.getItem('rt_name');
    if (savedName) return join();

    $('joinTitle').textContent = `Join “${name}”`;
    $('joinDest').textContent = d?.label ? `🏁 ${d.label}` : '';
    const count = info?.members?.length || 0;
    if (count) $('joinDest').textContent += `${d?.label ? ' · ' : ''}${count} rider${count === 1 ? '' : 's'} already in`;
    openModal('joinModal');
    setTimeout(() => $('joinName').focus(), 50);
  }

  boot();
})();
