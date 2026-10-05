(() => {
  const map = createMap('pickMap');
  let dest = null;
  let destMarker = null;

  $('yourName').value = localStorage.getItem('rt_name') || '';

  function setDest(d, fly) {
    dest = d;
    if (!destMarker) destMarker = L.marker([d.lat, d.lng], { icon: destIcon, draggable: true }).addTo(map);
    else destMarker.setLatLng([d.lat, d.lng]);
    destMarker.off('dragend').on('dragend', () => {
      const { lat, lng } = destMarker.getLatLng();
      dropPin(lat, lng);
    });
    if (fly) map.flyTo([d.lat, d.lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
    $('destLabel').innerHTML = `🏁 <strong>${escapeHtml(d.label)}</strong>`;
  }

  async function dropPin(lat, lng) {
    setDest({ lat, lng, label: 'Finding place…' }, false);
    const label = await reverseGeocode(lat, lng);
    if (dest && dest.lat === lat && dest.lng === lng) {
      setDest({ lat, lng, label }, false);
      $('destSearch').value = label;
    }
  }

  wireSearch($('destSearch'), $('destResults'), (r) => setDest(r, true), () => (map.getZoom() >= 8 ? map.getCenter() : null));
  renderSavedChips($('savedChips'), (r) => {
    $('destSearch').value = r.label;
    setDest(r, true);
  });

  // Start with the group's usual destination already selected; it can still be changed.
  if (SAVED_PLACES.length) {
    const p = SAVED_PLACES[0];
    map.setView([p.lat, p.lng], 12);
    setDest({ lat: p.lat, lng: p.lng, label: p.label }, false);
    $('destSearch').value = p.label;
  }
  map.on('click', (e) => dropPin(e.latlng.lat, e.latlng.lng));

  $('locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Location not supported on this device');
    navigator.geolocation.getCurrentPosition(
      (p) => map.flyTo([p.coords.latitude, p.coords.longitude], 13, { duration: 0.8 }),
      () => toast('Could not get your location'),
      { enableHighAccuracy: false, timeout: 10000 }
    );
  });

  $('createBtn').addEventListener('click', async () => {
    const yourName = $('yourName').value.trim();
    if (!yourName) {
      $('yourName').focus();
      return toast('Enter your name first 🙂');
    }
    localStorage.setItem('rt_name', yourName);
    const rideName = $('rideName').value.trim() || `${yourName}'s ride`;

    const btn = $('createBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/rides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: rideName, destination: dest }),
      });
      if (!res.ok) throw new Error('create failed');
      const { id } = await res.json();
      showShare(id, rideName);
    } catch {
      toast('Could not create the ride. Is the server running?', { type: 'error' });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create ride 🚀';
    }
  });

  function showShare(id, rideName) {
    const url = shareUrl(id, rideName, dest);
    const text = shareText(rideName, dest);
    $('shareTitle').textContent = `${rideName} is ready!`;
    $('rideCode').textContent = id;
    $('shareLink').value = url;
    $('waBtn').href = whatsappHref(text, url);
    $('openRideBtn').href = url;
    $('copyBtn').onclick = () => copyText(url);
    $('shareLink').onclick = (e) => e.target.select();
    $('nativeShareBtn').onclick = async () => {
      if (!(await nativeShare(rideName, text, url))) copyText(url);
    };
    $('createCard').classList.add('hidden');
    $('shareCard').classList.remove('hidden');
    $('shareCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('joinCode').value.trim();
    if (!raw) return;
    const fromLink = raw.match(/\/r\/([A-Za-z0-9]+)/);
    if (fromLink) {
      // Keep the full link (it carries the destination) when it points at this site.
      try {
        const u = new URL(raw);
        if (u.origin === location.origin) return (location.href = u.href);
      } catch { /* not a full URL */ }
      return (location.href = `/r/${fromLink[1].toUpperCase()}`);
    }
    const code = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (code.length !== 6) return toast('Codes are 6 characters long');
    location.href = `/r/${code}`;
  });
})();
