/* Otterotter — front-end logic
 * Reads data/events.json and data/facilitators.json (plain files, no backend).
 * Renders a Leaflet map, an event list with filters, a facilitator gallery,
 * and wires up tab navigation + the contribute form.
 */

(function () {
  "use strict";

  // ---- State ----
  var allEvents = [];
  var allFacilitators = [];
  var facilitatorFilter = null;  // facilitator id when filtering the map to one person
  var tripLayer = null;          // map layer for the road-trip route
  var markersById = {};
  var map, clusterGroup;

  var TYPE_LABELS = {
    jam: "Jam",
    class: "Class",
    workshop: "Workshop",
    festival: "Festival",
    retreat: "Retreat"
  };

  // ---- Helpers ----
  function parseDate(str) {
    // expects YYYY-MM-DD
    var p = (str || "").split("-");
    if (p.length !== 3) return null;
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function daysUntil(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return Infinity;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  }

  function isSoon(ev) {
    var du = daysUntil(ev.start_date);
    return du >= 0 && du <= 14;
  }

  function isPast(ev) {
    // past if its end date is before today
    return daysUntil(ev.end_date || ev.start_date) < 0;
  }

  function ym(dateStr) {
    // "2026-06-13" -> "2026-06"
    return (dateStr || "").slice(0, 7);
  }

  function monthLabel(ymStr) {
    var p = ymStr.split("-");
    var d = new Date(+p[0], +p[1] - 1, 1);
    return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }

  function inMonth(ev, ymStr) {
    if (!ymStr) return true;
    var s = ym(ev.start_date);
    var e = ym(ev.end_date || ev.start_date);
    return s <= ymStr && ymStr <= e; // event spans (or starts in) the chosen month
  }

  function formatDateRange(ev) {
    var opts = { day: "numeric", month: "short" };
    var s = parseDate(ev.start_date);
    var e = parseDate(ev.end_date);
    if (!s) return "";
    var str = s.toLocaleDateString("en-GB", opts);
    if (e && ev.end_date !== ev.start_date) {
      str += " – " + e.toLocaleDateString("en-GB", opts);
    }
    if (ev.time && ev.time !== "all day") str += " · " + ev.time;
    return str;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Only allow safe link schemes (blocks javascript:, data:, etc. from community data)
  function safeUrl(u) {
    if (!u) return "";
    var s = String(u).trim();
    return (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) ? s : "";
  }

  // ---- Event <-> facilitator linking (driven by facilitators.json `event_links`) ----
  function normLink(url) {
    if (!url) return "";
    return String(url).trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "")
      .split("?")[0].split("#")[0].replace(/\/+$/, "");
  }

  function facilitatorsForEvent(ev) {
    if (!ev || !ev.link) return [];
    var key = normLink(ev.link);
    return allFacilitators.filter(function (f) {
      return (f.event_links || []).some(function (l) { return normLink(l) === key; });
    });
  }

  function eventsForFacilitator(f) {
    var links = (f.event_links || []).map(normLink);
    if (!links.length) return [];
    return allEvents.filter(function (ev) {
      return ev.link && links.indexOf(normLink(ev.link)) !== -1;
    }).sort(function (a, b) { return daysUntil(a.start_date) - daysUntil(b.start_date); });
  }

  // ---- Map ----
  function initMap() {
    map = L.map("map", { scrollWheelZoom: true, worldCopyJump: true }).setView([52, 12], 4);
    // Opens focused on Europe; international events are still on the map when you zoom out.

    // Painterly Stamen Watercolor basemap (hosted by Stadia Maps).
    // Works key-free on localhost; for production add your domain in the free
    // Stadia dashboard (see README) — no code change needed.
    L.tileLayer("https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg", {
      minZoom: 1,
      maxZoom: 16,
      attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a> &copy; <a href="https://stamen.com/" target="_blank">Stamen Design</a> &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
    }).addTo(map);

    // Soft place-name labels on top (watercolor has none).
    L.tileLayer("https://tiles.stadiamaps.com/tiles/stamen_terrain_labels/{z}/{x}/{y}{r}.png", {
      minZoom: 1,
      maxZoom: 18,
      maxNativeZoom: 16,
      opacity: 0.9,
      attribution: ""
    }).addTo(map);
    clusterGroup = L.markerClusterGroup({ maxClusterRadius: 45 });
    map.addLayer(clusterGroup);
  }

  function markerHtml(ev) {
    var color = ev.featured ? "#d2613f" : (isSoon(ev) ? "#d2613f" : "#4f7a62");
    return (
      '<div class="pin-drop" style="background:' + color +
      ';width:20px;height:20px;"></div>'
    );
  }

  function buildMarkers(events) {
    clusterGroup.clearLayers();
    markersById = {};
    events.forEach(function (ev) {
      if (typeof ev.lat !== "number" || typeof ev.lng !== "number") return;
      var icon = L.divIcon({
        className: "otter-pin",
        html: markerHtml(ev),
        iconSize: [20, 20],
        iconAnchor: [10, 20],
        popupAnchor: [0, -18]
      });
      var m = L.marker([ev.lat, ev.lng], { icon: icon });
      m.bindPopup(
        '<p class="popup-title">' + escapeHtml(ev.title) + "</p>" +
        '<p class="popup-meta">' + escapeHtml(TYPE_LABELS[ev.type] || ev.type) +
        " · " + escapeHtml(ev.city) + ", " + escapeHtml(ev.country) + "<br>" +
        escapeHtml(formatDateRange(ev)) + "</p>" +
        (safeUrl(ev.link) ? '<a class="popup-link" href="' + escapeHtml(safeUrl(ev.link)) +
          '" target="_blank" rel="noopener">Event details →</a>' : "")
      );
      markersById[ev.id] = m;
      clusterGroup.addLayer(m);
    });
  }

  // ---- Event list ----
  function isLocated(ev) {
    return typeof ev.lat === "number" && isFinite(ev.lat) &&
           typeof ev.lng === "number" && isFinite(ev.lng);
  }

  function eventCardHtml(ev) {
    var badges = '<span class="badge type">' +
      escapeHtml(TYPE_LABELS[ev.type] || ev.type) + "</span>";
    if (ev.featured) badges += '<span class="badge featured">Featured</span>';
    if (isSoon(ev)) badges += '<span class="badge soon">Soon</span>';
    if (!isLocated(ev)) badges += '<span class="badge tbc">Location to be confirmed</span>';

    var facs = facilitatorsForEvent(ev);
    var facHtml = facs.length
      ? '<p class="event-facs">With ' + facs.map(function (f) {
          return '<a class="fac-chip" href="#facilitators-section" data-fac="' +
            escapeHtml(f.id) + '">' + escapeHtml(f.name) + "</a>";
        }).join(", ") + "</p>"
      : "";

    return (
      '<article class="event-card' + (ev.featured ? " featured" : "") +
      '" data-id="' + escapeHtml(ev.id) + '" tabindex="0">' +
      '<div class="badges">' + badges + "</div>" +
      "<h3>" + escapeHtml(ev.title) + "</h3>" +
      '<p class="event-meta">' + escapeHtml(formatDateRange(ev)) + " · " +
      escapeHtml([ev.venue, ev.city, ev.country].filter(Boolean).join(", ")) + "</p>" +
      '<p class="event-desc">' + escapeHtml(ev.description || "") + "</p>" +
      facHtml +
      (safeUrl(ev.link) ? '<a class="event-link" href="' + escapeHtml(safeUrl(ev.link)) +
        '" target="_blank" rel="noopener">Event details →</a>' : "") +
      "</article>"
    );
  }

  function renderList(events) {
    var list = document.getElementById("event-list");
    if (!events.length) {
      list.innerHTML = '<div class="empty-state">No events match your filters.<br>Try widening the date range or clearing search.</div>';
      return;
    }
    list.innerHTML = events.map(eventCardHtml).join("");

    // clicking a card focuses its marker
    Array.prototype.forEach.call(list.querySelectorAll(".event-card"), function (card) {
      function focusMarker() {
        var id = card.getAttribute("data-id");
        var m = markersById[id];
        if (m) {
          map.setView(m.getLatLng(), 9, { animate: true });
          clusterGroup.zoomToShowLayer(m, function () { m.openPopup(); });
        }
      }
      card.addEventListener("click", function (e) {
        if (e.target.tagName === "A") return; // let links work
        focusMarker();
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter") focusMarker();
      });
    });

    // clicking a facilitator chip jumps to that facilitator's profile
    Array.prototype.forEach.call(list.querySelectorAll(".fac-chip"), function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        showView("facilitators");
        var card = document.getElementById("fac-" + a.getAttribute("data-fac"));
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.classList.add("fac-flash");
          setTimeout(function () { card.classList.remove("fac-flash"); }, 1500);
        }
      });
    });
  }

  // ---- Filtering ----
  function applyFilters() {
    var q = document.getElementById("search").value.trim().toLowerCase();
    var type = document.getElementById("filter-type").value;
    var country = document.getElementById("filter-country").value;
    var month = document.getElementById("filter-month").value;
    var soonOnly = document.getElementById("filter-soon").checked;

    // when a facilitator is selected, restrict to the events they're linked to
    var facLinks = null;
    if (facilitatorFilter) {
      var fac = allFacilitators.filter(function (f) { return f.id === facilitatorFilter; })[0];
      facLinks = fac ? (fac.event_links || []).map(normLink) : [];
    }

    var filtered = allEvents.filter(function (ev) {
      if (facLinks && (!ev.link || facLinks.indexOf(normLink(ev.link)) === -1)) return false;
      if (isPast(ev)) return false;
      if (type && ev.type !== type) return false;
      if (country && ev.country !== country) return false;
      if (!inMonth(ev, month)) return false;
      if (soonOnly && !isSoon(ev)) return false;
      if (q) {
        var hay = (ev.title + " " + ev.city + " " + ev.country + " " +
          (ev.venue || "") + " " + (ev.description || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    // sort: featured first, then soonest date
    filtered.sort(function (a, b) {
      if (!!b.featured !== !!a.featured) return b.featured ? 1 : -1;
      return daysUntil(a.start_date) - daysUntil(b.start_date);
    });

    document.getElementById("result-count").textContent =
      filtered.length + (filtered.length === 1 ? " event" : " events");

    buildMarkers(filtered);
    renderList(filtered);
  }

  function populateCountryFilter() {
    var sel = document.getElementById("filter-country");
    var countries = {};
    allEvents.forEach(function (ev) { if (ev.country) countries[ev.country] = true; });
    Object.keys(countries).sort().forEach(function (c) {
      var o = document.createElement("option");
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
  }

  function populateMonthFilter() {
    var sel = document.getElementById("filter-month");
    var months = {};
    allEvents.forEach(function (ev) {
      if (isPast(ev)) return;
      // include every month the event touches, from start to end
      var s = ym(ev.start_date), e = ym(ev.end_date || ev.start_date);
      if (s) months[s] = true;
      if (e) months[e] = true;
    });
    Object.keys(months).sort().forEach(function (m) {
      var o = document.createElement("option");
      o.value = m; o.textContent = monthLabel(m);
      sel.appendChild(o);
    });
  }

  // ---- "Happening soon" strip ----
  function focusEvent(ev) {
    if (typeof ev.lat !== "number" || typeof ev.lng !== "number") return;
    map.setView([ev.lat, ev.lng], 8, { animate: true });
    var m = markersById[ev.id];
    if (m) {
      clusterGroup.zoomToShowLayer(m, function () { m.openPopup(); });
    }
  }

  function renderSoonStrip() {
    var wrap = document.getElementById("soon-wrap");
    var strip = document.getElementById("soon-strip");
    if (!wrap || !strip) return;
    // only events that haven't started yet (already-started ones stay on the map,
    // but it's odd to headline them as "happening soon")
    var upcoming = allEvents.filter(function (e) { return daysUntil(e.start_date) >= 0; });
    upcoming.sort(function (a, b) { return daysUntil(a.start_date) - daysUntil(b.start_date); });
    var soon = upcoming.slice(0, 8);
    if (!soon.length) { wrap.hidden = true; return; }
    wrap.hidden = false;

    strip.innerHTML = soon.map(function (ev) {
      var du = daysUntil(ev.start_date);
      var when = du <= 0 ? "Today" : (du === 1 ? "Tomorrow" : "in " + du + " days");
      return (
        '<button class="soon-card" data-id="' + escapeHtml(ev.id) + '" type="button">' +
        '<span class="soon-when">' + escapeHtml(when) + "</span>" +
        '<span class="soon-name">' + escapeHtml(ev.title) + "</span>" +
        '<span class="soon-place">' + escapeHtml([ev.city, ev.country].filter(Boolean).join(", ")) + "</span>" +
        '<span class="badge type">' + escapeHtml(TYPE_LABELS[ev.type] || ev.type) + "</span>" +
        "</button>"
      );
    }).join("");

    Array.prototype.forEach.call(strip.querySelectorAll(".soon-card"), function (card) {
      card.addEventListener("click", function () {
        var ev = allEvents.filter(function (e) { return e.id === card.getAttribute("data-id"); })[0];
        if (ev) {
          showView("events");
          focusEvent(ev);
          document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    });
  }

  // ---- Facilitators ----
  function renderFacilitators() {
    var grid = document.getElementById("facilitator-grid");
    if (!grid) return;
    if (!allFacilitators.length) {
      grid.innerHTML = '<div class="empty-state">No facilitators listed yet.</div>';
      return;
    }
    var list = allFacilitators.slice().sort(function (a, b) {
      return (a.name || "").localeCompare(b.name || "");
    });
    grid.innerHTML = list.map(function (f) {
      var initials = (f.name || "?").split(/\s+/).map(function (w) { return w[0]; })
        .slice(0, 2).join("").toUpperCase();
      var mods = (f.modalities || []).map(function (m) {
        return '<span class="badge">' + escapeHtml(m) + "</span>";
      }).join("");
      var avatar = f.photo
        ? '<img class="avatar avatar-img" src="' + escapeHtml(f.photo) +
          '" alt="' + escapeHtml(f.name) + '" loading="lazy" />'
        : '<div class="avatar">' + escapeHtml(initials) + "</div>";

      var n = eventsForFacilitator(f).length;
      var cta = n
        ? '<p class="fac-cta">See ' + n + " event" + (n > 1 ? "s" : "") +
          " on the map →</p>"
        : "";

      return (
        '<article class="facilitator-card' + (n ? " is-clickable" : "") +
        '" id="fac-' + escapeHtml(f.id) + '" data-fac-id="' + escapeHtml(f.id) +
        '"' + (n ? ' tabindex="0" role="button"' : "") + ">" +
        avatar +
        "<h3>" + escapeHtml(f.name) + "</h3>" +
        '<p class="loc">' + escapeHtml(f.location || "") + "</p>" +
        '<p class="bio">' + escapeHtml(f.bio_short || "") + "</p>" +
        '<div class="mods">' + mods + "</div>" +
        cta +
        (safeUrl(f.website) ? '<a class="event-link" href="' + escapeHtml(safeUrl(f.website)) +
          '" target="_blank" rel="noopener">Visit website →</a>' : "") +
        "</article>"
      );
    }).join("");

    // clicking a facilitator card filters the map/list to that person's events
    Array.prototype.forEach.call(grid.querySelectorAll(".facilitator-card.is-clickable"), function (card) {
      function go(e) {
        if (e.target.tagName === "A") return;  // let the website link work
        setFacilitatorFilter(card.getAttribute("data-fac-id"));
      }
      card.addEventListener("click", go);
      card.addEventListener("keydown", function (e) { if (e.key === "Enter") go(e); });
    });
  }

  // ---- Facilitator → map filter ----
  function setFacilitatorFilter(id) {
    facilitatorFilter = id;
    showView("events");
    window.scrollTo({ top: 0, behavior: "smooth" });
    applyFilters();
    updateFacChip();
    fitToFacilitator();
  }

  function clearFacilitatorFilter() {
    facilitatorFilter = null;
    applyFilters();
    updateFacChip();
  }

  function updateFacChip() {
    var bar = document.getElementById("fac-filter-bar");
    if (!facilitatorFilter) { if (bar) bar.parentNode.removeChild(bar); return; }
    var fac = allFacilitators.filter(function (f) { return f.id === facilitatorFilter; })[0];
    var name = fac ? fac.name : "this facilitator";
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "fac-filter-bar";
      bar.className = "fac-filter-bar";
      var filters = document.querySelector(".filters");
      filters.parentNode.insertBefore(bar, filters);
    }
    bar.innerHTML = 'Showing events with <strong>' + escapeHtml(name) +
      '</strong> <button type="button" class="fac-clear">show all ✕</button>';
    bar.querySelector(".fac-clear").addEventListener("click", clearFacilitatorFilter);
  }

  function fitToFacilitator() {
    if (!map || typeof map.fitBounds !== "function") return;
    var fac = allFacilitators.filter(function (f) { return f.id === facilitatorFilter; })[0];
    if (!fac) return;
    var links = (fac.event_links || []).map(normLink);
    var pts = allEvents.filter(function (ev) {
      return ev.link && links.indexOf(normLink(ev.link)) !== -1 &&
        typeof ev.lat === "number" && typeof ev.lng === "number";
    }).map(function (ev) { return [ev.lat, ev.lng]; });
    if (pts.length === 1) map.setView(pts[0], 7, { animate: true });
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 8 });
  }

  // ---- Navigation (tabs) ----
  function showView(view) {
    Array.prototype.forEach.call(document.querySelectorAll(".view"), function (v) {
      v.classList.remove("active-view");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".nav-link"), function (n) {
      n.classList.toggle("active", n.getAttribute("data-view") === view);
    });
    var section = document.querySelector(".view-" + view);
    if (section) {
      section.classList.add("active-view");
      if (view === "events" && map) setTimeout(function () { map.invalidateSize(); }, 50);
    }
  }

  function initNav() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        showView(link.getAttribute("data-view"));
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    // Clicking the logo / title returns to the landing state (like a refresh).
    var brand = document.querySelector(".brand");
    if (brand) {
      brand.addEventListener("click", function (e) {
        e.preventDefault();
        ["search", "filter-type", "filter-country", "filter-month"].forEach(function (id) {
          document.getElementById(id).value = "";
        });
        document.getElementById("filter-soon").checked = false;
        applyFilters();
        showView("events");
        if (map) map.setView([52, 12], 4);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }
  }

  // ---- Contribute form ----
  function initForm() {
    var form = document.getElementById("contribute-form");
    var note = document.getElementById("form-note");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      note.style.color = "";
      note.textContent = "Sending…";
      var body = new URLSearchParams(new FormData(form)).toString();
      fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        form.reset();
        note.style.color = "var(--moss)";
        note.textContent = "Thank you! Your submission was received — we review everything before it appears on the map.";
      }).catch(function () {
        note.style.color = "#b4521f";
        note.textContent = "Hmm, that didn't send. Please try again, or email us.";
      });
    });
  }

  // ---- Road-trip planner ----
  function haversineKm(aLat, aLng, bLat, bLng) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function segDistKm(pLat, pLng, aLat, aLng, bLat, bLng) {
    // local equirectangular projection to km, then point-to-segment distance
    var refLat = ((aLat + bLat) / 2) * Math.PI / 180;
    var kx = 111.32 * Math.cos(refLat), ky = 110.57;
    var ax = aLng * kx, ay = aLat * ky, bx = bLng * kx, by = bLat * ky, px = pLng * kx, py = pLat * ky;
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  function daysBetween(a, b) {
    var pa = parseDate(a), pb = parseDate(b);
    return (pa && pb) ? Math.round((pb - pa) / 86400000) : 0;
  }

  function geocodePlace(q) {
    return fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (h) {
        if (h && h[0]) return [parseFloat(h[0].lat), parseFloat(h[0].lon)];
        throw new Error("not found");
      });
  }

  function planTrip() {
    var startQ = document.getElementById("trip-start").value.trim();
    var endQ = document.getElementById("trip-end").value.trim() || startQ;
    var fromD = document.getElementById("trip-from").value;
    var toD = document.getElementById("trip-to").value;
    var corridor = +document.getElementById("trip-corridor").value;
    var status = document.getElementById("trip-status");
    if (!startQ || !fromD || !toD) { status.textContent = "Please fill in start, from and to."; return; }
    if (fromD > toD) { status.textContent = "‘From’ is after ‘To’ — check the dates."; return; }
    status.textContent = "Finding your route…";
    Promise.all([geocodePlace(startQ), geocodePlace(endQ)]).then(function (res) {
      var start = res[0], end = res[1];
      var stops = allEvents.filter(function (ev) {
        if (!isLocated(ev)) return false;
        var s = ev.start_date, e = ev.end_date || ev.start_date;
        if (!(s <= toD && e >= fromD)) return false;  // overlaps the date window
        return segDistKm(ev.lat, ev.lng, start[0], start[1], end[0], end[1]) <= corridor;
      }).sort(function (a, b) { return a.start_date < b.start_date ? -1 : (a.start_date > b.start_date ? 1 : 0); });
      drawTrip(start, end, stops, startQ, endQ);
      renderItinerary(start, end, stops);
      status.textContent = stops.length
        ? (stops.length + " festival" + (stops.length > 1 ? "s" : "") + " along your route")
        : "No festivals on this route in these dates — try a wider detour or longer window.";
    }).catch(function () {
      status.textContent = "Couldn't find one of those places — try ‘City, Country’.";
    });
  }

  function drawTrip(start, end, stops, startName, endName) {
    if (!map) return;
    if (tripLayer) map.removeLayer(tripLayer);
    if (clusterGroup) clusterGroup.clearLayers();
    tripLayer = L.layerGroup().addTo(map);
    var pts = [start].concat(stops.map(function (s) { return [s.lat, s.lng]; })).concat([end]);
    L.polyline(pts, { color: "#d2613f", weight: 3, dashArray: "6 8", opacity: 0.85 }).addTo(tripLayer);
    L.marker(start).addTo(tripLayer).bindPopup("Start: " + escapeHtml(startName));
    if (normLink(endName) !== normLink(startName))
      L.marker(end).addTo(tripLayer).bindPopup("End: " + escapeHtml(endName));
    stops.forEach(function (s, i) {
      var icon = L.divIcon({ className: "trip-pin", html: '<div class="trip-num">' + (i + 1) + "</div>",
        iconSize: [26, 26], iconAnchor: [13, 13] });
      L.marker([s.lat, s.lng], { icon: icon }).addTo(tripLayer)
        .bindPopup("<b>" + escapeHtml(s.title) + "</b><br>" + escapeHtml(formatDateRange(s)));
    });
    if (pts.length && typeof map.fitBounds === "function") map.fitBounds(pts, { padding: [40, 40] });
  }

  function renderItinerary(start, end, stops) {
    var list = document.getElementById("event-list");
    document.getElementById("result-count").textContent = stops.length + (stops.length === 1 ? " stop" : " stops");
    if (!stops.length) {
      list.innerHTML = '<div class="empty-state">No festivals on this route in these dates.<br>Try a wider detour or a longer date window.</div>';
      return;
    }
    var prev = start, total = 0, html = "";
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      var legKm = Math.round(haversineKm(prev[0], prev[1], s.lat, s.lng));
      total += legKm;
      var warn = "";
      if (i > 0) {
        var gap = daysBetween(stops[i - 1].end_date || stops[i - 1].start_date, s.start_date);
        if (gap < 0) warn = '<span class="badge tbc">overlaps previous</span>';
        else if (legKm / Math.max(gap, 1) > 700) warn = '<span class="badge soon">tight connection</span>';
      }
      html += '<article class="event-card">' +
        '<div class="badges"><span class="badge type">Stop ' + (i + 1) + "</span>" + warn + "</div>" +
        "<h3>" + escapeHtml(s.title) + "</h3>" +
        '<p class="event-meta">' + escapeHtml(formatDateRange(s)) + " · " +
        escapeHtml([s.city, s.country].filter(Boolean).join(", ")) + "</p>" +
        '<p class="event-desc">' + legKm + " km from " + (i === 0 ? "start" : "previous stop") + "</p>" +
        (safeUrl(s.link) ? '<a class="event-link" href="' + escapeHtml(safeUrl(s.link)) +
          '" target="_blank" rel="noopener">Event details →</a>' : "") +
        "</article>";
      prev = [s.lat, s.lng];
    }
    total += Math.round(haversineKm(prev[0], prev[1], end[0], end[1]));
    list.innerHTML = '<div class="trip-summary">' + stops.length + " stops · ~" + total + " km total</div>" + html;
  }

  function clearTrip() {
    if (tripLayer) { map.removeLayer(tripLayer); tripLayer = null; }
    document.getElementById("trip-status").textContent = "";
    applyFilters();  // restore normal markers + list
  }

  function initTrip() {
    var toggle = document.getElementById("trip-toggle"), panel = document.getElementById("trip-panel");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle("open", !panel.hidden);
      if (!panel.hidden && map) setTimeout(function () { map.invalidateSize(); }, 50);
    });
    document.getElementById("trip-plan").addEventListener("click", planTrip);
    document.getElementById("trip-clear").addEventListener("click", clearTrip);
  }

  // ---- Data loading ----
  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function init() {
    initMap();
    initNav();
    initForm();
    initTrip();

    // filter listeners
    ["search", "filter-type", "filter-country"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", applyFilters);
    });
    document.getElementById("filter-soon").addEventListener("change", applyFilters);
    document.getElementById("filter-month").addEventListener("change", applyFilters);

    loadJSON("data/events.json")
      .then(function (data) {
        allEvents = (data.events || []).filter(function (e) {
          return e && e.id && e.source !== "sample";  // hide seed/example events
        });
        populateCountryFilter();
        populateMonthFilter();
        applyFilters();
        renderSoonStrip();
        renderFacilitators();  // facilitator cards list their events once events are known
      })
      .catch(function (err) {
        document.getElementById("event-list").innerHTML =
          '<div class="empty-state">Could not load events (' + escapeHtml(err.message) +
          ').<br>If you opened this file directly, run a local server — see README.</div>';
      });

    loadJSON("data/facilitators.json")
      .then(function (data) {
        allFacilitators = data.facilitators || [];
        renderFacilitators();
        applyFilters();  // event cards pick up facilitator chips once facilitators are known
      })
      .catch(function () { allFacilitators = []; renderFacilitators(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
