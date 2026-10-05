// Turn-by-turn navigation helpers: OSRM routes with steps, progress along the route,
// instruction text (English on screen, English or Hindi voice) and maneuver icons.
const RideNav = (() => {
  const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

  // ---------- routing ----------
  async function fetchRoute(from, to, heading) {
    const base = `${OSRM}${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    // Passing the current heading stops OSRM from routing through a U-turn right at the start.
    const urls = heading != null ? [`${base}&bearings=${Math.round(heading) % 360},60;`, base] : [base];
    let lastError = null;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.code === 'Ok' && data.routes?.length) return buildModel(data.routes[0]);
        lastError = new Error(data.message || 'No route found');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // Flat x/y metres around the route start: accurate enough for city-to-city distances.
  function buildModel(route) {
    const coords = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    const kx = 111320 * Math.cos((coords[0].lat * Math.PI) / 180);
    const ky = 110540;
    const pts = coords.map((c) => ({ x: c.lng * kx, y: c.lat * ky }));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);

    const model = { coords, pts, cum, kx, ky, length: cum[cum.length - 1], duration: route.duration, hint: 0, steps: [] };
    let hint = 0;
    model.steps = route.legs.flatMap((leg) => leg.steps).map((s) => {
      const [lng, lat] = s.maneuver.location;
      const p = project(model, { lat, lng }, hint, true);
      hint = p.seg;
      return {
        type: s.maneuver.type,
        modifier: s.maneuver.modifier || 'straight',
        exit: s.maneuver.exit,
        bearingAfter: s.maneuver.bearing_after,
        name: s.name || '',
        ref: s.ref || '',
        at: p.s, // distance along the route where this maneuver happens
      };
    });
    model.end = coords[coords.length - 1];
    return model;
  }

  // Nearest point on the route to `pos`: { seg, t, dist (m off the route), s (m along the route) }.
  function project(m, pos, hint = 0, forwardOnly = false) {
    const P = { x: pos.lng * m.kx, y: pos.lat * m.ky };
    const scan = (from, to) => {
      let best = null;
      for (let i = Math.max(0, from); i < Math.min(m.pts.length - 1, to); i++) {
        const A = m.pts[i];
        const B = m.pts[i + 1];
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2)) : 0;
        const d = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
        if (!best || d < best.dist) best = { seg: i, t, dist: d, s: m.cum[i] + t * Math.sqrt(len2) };
      }
      return best;
    };
    // Look near the last known spot first so overlapping roads don't make us jump around.
    let best = scan(forwardOnly ? hint : hint - 20, hint + 400);
    if (!best || best.dist > 40) {
      const all = scan(forwardOnly ? hint : 0, m.pts.length);
      if (all && (!best || all.dist < best.dist)) best = all;
    }
    return best || { seg: 0, t: 0, dist: Infinity, s: 0 };
  }

  function pointAt(m, seg, t) {
    const a = m.coords[seg];
    const b = m.coords[Math.min(seg + 1, m.coords.length - 1)];
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  // Steps that don't need the rider to do anything (road just changes name, goes straight on).
  function isSilent(st) {
    if (['new name', 'notification', 'exit roundabout', 'exit rotary', 'depart'].includes(st.type)) return true;
    if (['continue', 'use lane'].includes(st.type) && st.modifier === 'straight') return true;
    return false;
  }

  function progress(m, pos) {
    const p = project(m, pos, m.hint);
    m.hint = p.seg;
    const idx = m.steps.findIndex((st, i) => i > 0 && !isSilent(st) && st.at > p.s + 3);
    const nextIdx = idx === -1 ? m.steps.length - 1 : idx;
    const next = m.steps[nextIdx];
    const afterIdx = m.steps.findIndex((st, i) => i > nextIdx && !isSilent(st));
    const remaining = Math.max(0, m.length - p.s);
    return {
      s: p.s,
      seg: p.seg,
      t: p.t,
      offRoute: p.dist,
      snapped: pointAt(m, p.seg, p.t),
      nextIdx,
      next,
      distToNext: Math.max(0, next.at - p.s),
      after: afterIdx === -1 ? null : m.steps[afterIdx],
      afterGap: afterIdx === -1 ? Infinity : m.steps[afterIdx].at - next.at,
      remaining,
      remainingTime: m.length ? (m.duration * remaining) / m.length : 0,
    };
  }

  // Route still ahead of the rider, for drawing.
  function remainingLine(m, pr) {
    return [pr.snapped, ...m.coords.slice(pr.seg + 1)].map((c) => [c.lat, c.lng]);
  }

  // ---------- instructions ----------
  const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const ORD_EN = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
  const ORD_HI = ['पहला', 'दूसरा', 'तीसरा', 'चौथा', 'पाँचवाँ', 'छठा', 'सातवाँ', 'आठवाँ'];
  const TURN_EN = {
    uturn: 'Make a U-turn',
    'sharp right': 'Turn sharp right',
    right: 'Turn right',
    'slight right': 'Slight right',
    straight: 'Go straight',
    'slight left': 'Slight left',
    left: 'Turn left',
    'sharp left': 'Turn sharp left',
  };
  const TURN_HI = {
    uturn: 'यू-टर्न लें',
    'sharp right': 'तेज़ दाएं मुड़ें',
    right: 'दाएं मुड़ें',
    'slight right': 'हल्का दाएं मुड़ें',
    straight: 'सीधे चलें',
    'slight left': 'हल्का बाएं मुड़ें',
    left: 'बाएं मुड़ें',
    'sharp left': 'तेज़ बाएं मुड़ें',
  };

  const road = (st) => st.name || st.ref.split(';')[0].trim();
  const side = (mod) => (mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : 'straight');
  const sideHi = (mod) => ({ left: 'बाएं', right: 'दाएं', straight: 'सीधे' })[side(mod)];

  function textEn(st) {
    const r = road(st);
    const onto = r ? ` onto ${r}` : '';
    const turn = TURN_EN[st.modifier] || 'Continue';
    switch (st.type) {
      case 'depart':
        return `Head ${COMPASS[Math.round((st.bearingAfter || 0) / 45) % 8]}${r ? ` on ${r}` : ''}`;
      case 'arrive':
        return side(st.modifier) === 'straight' ? 'Arrive at the destination' : `Destination is on the ${side(st.modifier)}`;
      case 'roundabout':
      case 'rotary':
        return st.exit ? `At the roundabout, take the ${ORD_EN[st.exit - 1] || `${st.exit}th`} exit${onto}` : `Enter the roundabout${onto}`;
      case 'roundabout turn':
        return `At the roundabout, ${turn.toLowerCase()}${onto}`;
      case 'exit roundabout':
      case 'exit rotary':
        return `Exit the roundabout${onto}`;
      case 'fork':
        return `Keep ${side(st.modifier)} at the fork${onto}`;
      case 'end of road':
        return `At the end of the road, ${turn.toLowerCase()}${onto}`;
      case 'merge':
        return `Merge ${side(st.modifier)}${onto}`;
      case 'on ramp':
        return `Take the ramp on the ${side(st.modifier)}${onto}`;
      case 'off ramp':
        return `Take the exit on the ${side(st.modifier)}${onto}`;
      case 'continue':
      case 'use lane':
      case 'new name':
      case 'notification':
        return st.modifier === 'straight' ? `Continue straight${onto}` : `Keep ${side(st.modifier)}${onto}`;
      default:
        return `${turn}${onto}`;
    }
  }

  function textHi(st) {
    const r = road(st);
    const on = r ? `${r} पर ` : '';
    const turn = TURN_HI[st.modifier] || 'आगे बढ़ें';
    switch (st.type) {
      case 'depart':
        return `${on}आगे बढ़ें`;
      case 'arrive':
        return side(st.modifier) === 'straight' ? 'आप अपनी मंज़िल पर पहुँच गए हैं' : `मंज़िल आपके ${sideHi(st.modifier)} ओर है`;
      case 'roundabout':
      case 'rotary':
        return st.exit ? `गोल चक्कर पर ${ORD_HI[st.exit - 1] || st.exit} निकास लें` : 'गोल चक्कर में जाएं';
      case 'roundabout turn':
        return `गोल चक्कर पर ${turn}`;
      case 'exit roundabout':
      case 'exit rotary':
        return 'गोल चक्कर से बाहर निकलें';
      case 'fork':
        return `दोराहे पर ${sideHi(st.modifier)} रहें`;
      case 'end of road':
        return `सड़क के आख़िर में ${turn}`;
      case 'merge':
        return `${sideHi(st.modifier)} ओर से सड़क में मिलें`;
      case 'on ramp':
        return `${sideHi(st.modifier)} ओर का रैंप लें`;
      case 'off ramp':
        return `${sideHi(st.modifier)} ओर से निकलें`;
      case 'continue':
      case 'use lane':
      case 'new name':
      case 'notification':
        return st.modifier === 'straight' ? 'सीधे चलते रहें' : `${sideHi(st.modifier)} रहें`;
      default:
        return `${on}${turn}`;
    }
  }

  function roundForSpeech(m) {
    if (m < 100) return Math.max(10, Math.round(m / 10) * 10);
    if (m < 1000) return Math.round(m / 50) * 50;
    return Math.round(m / 100) * 100;
  }

  function speechDistance(m, lang) {
    const r = roundForSpeech(m);
    if (r < 1000) return lang === 'hi' ? `${r} मीटर` : `${r} meters`;
    const km = (r / 1000).toFixed(1).replace(/\.0$/, '');
    return lang === 'hi' ? `${km} किलोमीटर` : `${km} kilometers`;
  }

  // "In 200 meters, turn right onto Katol Road" / "200 मीटर बाद, Katol Road पर दाएं मुड़ें"
  function speech(st, distance, lang, then) {
    const text = lang === 'hi' ? textHi(st) : textEn(st);
    let out;
    if (distance == null) out = lang === 'hi' ? `अब, ${text}` : text;
    else out = lang === 'hi' ? `${speechDistance(distance, lang)} बाद, ${text}` : `In ${speechDistance(distance, lang)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    if (then) out += lang === 'hi' ? `, फिर ${textHi(then)}` : `, then ${textEn(then).charAt(0).toLowerCase()}${textEn(then).slice(1)}`;
    return out;
  }

  function continueFor(distance, lang) {
    return lang === 'hi' ? `${speechDistance(distance, lang)} तक सीधे चलते रहें` : `Continue for ${speechDistance(distance, lang)}`;
  }

  // ---------- icons ----------
  const svg = (body, flip) =>
    `<svg viewBox="0 0 48 48" class="mv${flip ? ' flip' : ''}" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    straight: '<path d="M24 42V8"/><path d="M13 19 24 8l11 11"/>',
    right: '<path d="M14 42V28a8 8 0 0 1 8-8h17"/><path d="m30 11 9 9-9 9"/>',
    'slight right': '<path d="M17 42V30l17-17"/><path d="M23 12h12v12"/>',
    'sharp right': '<path d="M14 42V12l20 20"/><path d="M34 21v12H22"/>',
    uturn: '<path d="M14 42V20a10 10 0 0 1 20 0v15"/><path d="m26 28 8 8 8-8"/>',
    roundabout: '<circle cx="24" cy="21" r="8"/><path d="M24 42V29"/><path d="m30 15 8-8"/><path d="M30 7h8v8"/>',
    arrive: '<path d="M14 42V7"/><path d="M14 8h20l-5 7 5 7H14"/>',
  };

  function icon(st) {
    if (st.type === 'arrive') return svg(ICONS.arrive);
    if (['roundabout', 'rotary', 'roundabout turn'].includes(st.type)) return svg(ICONS.roundabout);
    if (st.modifier === 'uturn') return svg(ICONS.uturn);
    const flip = st.modifier.includes('left');
    return svg(ICONS[st.modifier.replace('left', 'right')] || ICONS.straight, flip);
  }

  return { fetchRoute, progress, remainingLine, textEn, speech, continueFor, icon, isSilent };
})();
