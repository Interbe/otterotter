// Netlify Function: proxy to OpenRouteService driving directions.
// Keeps the ORS key secret (set ORS_API_KEY in Netlify env vars).
// Called as: /.netlify/functions/route?from=<lng,lat>&to=<lng,lat>
// Returns { ok:true, km, min } for a drivable route, or { ok:false } when there is
// no road route (sea gap / ferry-only island).

function reply(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function (event) {
  var q = event.queryStringParameters || {};
  if (!q.from || !q.to) return reply(400, { ok: false, error: "missing from/to" });
  var key = process.env.ORS_API_KEY;
  if (!key) return reply(500, { ok: false, error: "ORS_API_KEY not configured" });

  var url = "https://api.openrouteservice.org/v2/directions/driving-car" +
    "?api_key=" + encodeURIComponent(key) +
    "&start=" + encodeURIComponent(q.from) +
    "&end=" + encodeURIComponent(q.to);
  try {
    var r = await fetch(url);
    var d = await r.json();
    var s = d && d.features && d.features[0] && d.features[0].properties &&
            d.features[0].properties.summary;
    if (s && typeof s.distance === "number") {
      return reply(200, { ok: true, km: s.distance / 1000, min: s.duration / 60 });
    }
    return reply(200, { ok: false });  // no drivable route between these points
  } catch (e) {
    return reply(200, { ok: false, error: String(e) });
  }
};
