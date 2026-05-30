/* Otterotter — front-end logic
 * Reads data/events.json and data/facilitators.json (plain files, no backend).
 * Renders a Leaflet map, an event list with filters, a facilitator gallery,
 * and wires up tab navigation + the contribute form.
 */

(function () {
  "use strict";

  // ---- State ----
  var allEvents = [];
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

  // ---- Map ----
  function initMap() {
    map = L.map("map", { scrollWheelZoom: true }).setView([52.0, 12.0], 4);

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
        (ev.link ? '<a class="popup-link" href="' + escapeHtml(ev.link) +
          '" target="_blank" rel="noopener">Event details →</a>' : "")
      );
      markersById[ev.id] = m;
      clusterGroup.addLayer(m);
    });
  }

  // ---- Event list ----
  function eventCardHtml(ev) {
    var badges = '<span class="badge type">' +
      escapeHtml(TYPE_LABELS[ev.type] || ev.type) + "</span>";
    if (ev.featured) badges += '<span class="badge featured">Featured</span>';
    if (isSoon(ev)) badges += '<span class="badge soon">Soon</span>';

    return (
      '<article class="event-card' + (ev.featured ? " featured" : "") +
      '" data-id="' + escapeHtml(ev.id) + '" tabindex="0">' +
      '<div class="badges">' + badges + "</div>" +
      "<h3>" + escapeHtml(ev.title) + "</h3>" +
      '<p class="event-meta">' + escapeHtml(formatDateRange(ev)) + " · " +
      escapeHtml(ev.venue ? ev.venue + ", " : "") + escapeHtml(ev.city) + ", " +
      escapeHtml(ev.country) + "</p>" +
      '<p class="event-desc">' + escapeHtml(ev.description || "") + "</p>" +
      (ev.link ? '<a class="event-link" href="' + escapeHtml(ev.link) +
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
  }

  // ---- Filtering ----
  function applyFilters() {
    var q = document.getElementById("search").value.trim().toLowerCase();
    var type = document.getElementById("filter-type").value;
    var country = document.getElementById("filter-country").value;
    var month = document.getElementById("filter-month").value;
    var soonOnly = document.getElementById("filter-soon").checked;

    var filtered = allEvents.filter(function (ev) {
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

  // ---- Facilitators ----
  function renderFacilitators(list) {
    var grid = document.getElementById("facilitator-grid");
    if (!list || !list.length) {
      grid.innerHTML = '<div class="empty-state">No facilitators listed yet.</div>';
      return;
    }
    grid.innerHTML = list.map(function (f) {
      var initials = (f.name || "?").split(/\s+/).map(function (w) { return w[0]; })
        .slice(0, 2).join("").toUpperCase();
      var mods = (f.modalities || []).map(function (m) {
        return '<span class="badge">' + escapeHtml(m) + "</span>";
      }).join("");
      return (
        '<article class="facilitator-card">' +
        '<div class="avatar">' + escapeHtml(initials) + "</div>" +
        "<h3>" + escapeHtml(f.name) + "</h3>" +
        '<p class="loc">' + escapeHtml(f.location || "") + "</p>" +
        '<p class="bio">' + escapeHtml(f.bio_short || "") + "</p>" +
        '<div class="mods">' + mods + "</div>" +
        (f.website ? '<a class="event-link" href="' + escapeHtml(f.website) +
          '" target="_blank" rel="noopener">Visit website →</a>' : "") +
        "</article>"
      );
    }).join("");
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
  }

  // ---- Contribute form ----
  function initForm() {
    var form = document.getElementById("contribute-form");
    var note = document.getElementById("form-note");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      // If the Formspree endpoint isn't configured yet, intercept and explain.
      if (form.getAttribute("action").indexOf("YOUR_FORM_ID") !== -1) {
        e.preventDefault();
        note.style.color = "#b4521f";
        note.textContent = "Form not connected yet — see README to add a free Formspree/Netlify endpoint. Your details were not sent.";
      } else {
        note.style.color = "";
        note.textContent = "Sending…";
      }
    });
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

    // filter listeners
    ["search", "filter-type", "filter-country"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", applyFilters);
    });
    document.getElementById("filter-soon").addEventListener("change", applyFilters);
    document.getElementById("filter-month").addEventListener("change", applyFilters);

    loadJSON("data/events.json")
      .then(function (data) {
        allEvents = (data.events || []).filter(function (e) { return e && e.id; });
        populateCountryFilter();
        populateMonthFilter();
        applyFilters();
      })
      .catch(function (err) {
        document.getElementById("event-list").innerHTML =
          '<div class="empty-state">Could not load events (' + escapeHtml(err.message) +
          ').<br>If you opened this file directly, run a local server — see README.</div>';
      });

    loadJSON("data/facilitators.json")
      .then(function (data) { renderFacilitators(data.facilitators || []); })
      .catch(function () { renderFacilitators([]); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
