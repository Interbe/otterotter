// Netlify Function: proxy to OpenRouteService driving directions.
// Keeps the ORS key secret (set ORS_API_KEY in Netlify env vars).
// Called as: /.netlify/functions/route?from=<lng,lat>&to=<lng,lat>
//
// Returns one of:
//   { ok:true, km, min }     a drivable route was found
//   { ok:false }             ORS clearly reports NO drivable route (island / sea gap)
//   { unavailable:true }     couldn't check (rate-limited / error) -> caller keeps the
//                            stop using straight-line distance, rather than dropping it
// This distinction matters: rate-limit errors must NOT look like "not drivable", or the
// planner would drop every stop and return an empty trip.

function reply(obj) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function (event) {
  var q = event.queryStringParameters || {};
  if (!q.from || !q.to) return reply({ unavailable: true, error: "missing from/to" });
  var key = process.env.ORS_API_KEY;
  if (!key) return reply({ unavailable: true, error: "ORS_API_KEY not configured" });

  var url = "https://api.openrouteservice.org/v2/directions/driving-car" +
    "?api_key=" + encodeURIComponent(key) +
    "&start=" + encodeURIComponent(q.from) +
    "&end=" + encodeURIComponent(q.to);
  try {
    var r = await fetch(url);
    var d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    var s = d && d.features && d.features[0] && d.features[0].properties &&
            d.features[0].properties.summary;
    if (s && typeof s.distance === "number") {
      return reply({ ok: true, km: s.distance / 1000, min: s.duration / 60 });
    }
    // ORS routing errors: 2009 = route not found, 2010 = point not found near a road.
    // Those are genuine "can't drive there". Everything else (rate limit 429, server
    // errors, unexpected shapes) -> "couldn't check", so the planner keeps the stop.
    var code = d && d.error && (d.error.code || d.error);
    if (code === 2009 || code === 2010) return reply({ ok: false });
    return reply({ unavailable: true });
  } catch (e) {
    return reply({ unavailable: true, error: String(e) });
  }
};
