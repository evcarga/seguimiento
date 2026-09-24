/* Sentinel - pagina de seguimiento.
 *
 * Lo unico que esta pagina puede pedir es get_tracking(token): coordenadas y
 * hora de los puntos de UNA guardia. La anon key es publica por diseno (va
 * tambien dentro de la app) y no da acceso a ninguna tabla: todo pasa por esa
 * funcion, que valida el token y su vencimiento en la base.
 */
(function () {
  "use strict";

  var SUPABASE_URL = "https://oxzhmeeyiesflhhhehpa.supabase.co";
  var ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94emhtZWV5aWVzZmxoaGhlaHBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MzQyMjEsImV4cCI6MjEwNDMxMDIyMX0.iwAwe-sylkP8HYQ8OhH4TRMveaX4GjVMEArxkItsosE";
  var REFRESH_MS = 20000;
  var TIMES_MIN_ZOOM = 14;

  var $ = function (id) { return document.getElementById(id); };

  // El token viaja en el fragmento (#t=...): el navegador no lo manda nunca a
  // GitHub ni a los servidores de mapas.
  function readToken() {
    var m = /(?:^|[#&])t=([A-Za-z0-9_-]{32,128})(?:&|$)/.exec(location.hash);
    return m ? m[1] : null;
  }

  var token = readToken();
  var map = null;
  var layer = null;
  var markers = [];
  var points = [];
  var clockOffset = 0; // servidor - dispositivo, para el "hace X min"
  var timer = null;
  var firstFit = true;
  var lastSignature = "";

  var fmtTime = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
  var fmtDay = new Intl.DateTimeFormat("es", { day: "2-digit", month: "short" });
  var fmtFull = new Intl.DateTimeFormat("es", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function label(date, multiDay) {
    return multiDay ? fmtDay.format(date) + " " + fmtTime.format(date) : fmtTime.format(date);
  }

  function ago(date) {
    var s = Math.max(0, Math.round((Date.now() + clockOffset - date.getTime()) / 1000));
    if (s < 60) return "hace unos segundos";
    var m = Math.round(s / 60);
    if (m < 60) return "hace " + m + " min";
    var h = Math.floor(m / 60);
    return "hace " + h + " h " + (m % 60) + " min";
  }

  function setStatus(kind, text) {
    var el = $("status");
    el.className = "pill pill-" + kind;
    el.textContent = text;
  }

  function showGone() {
    stopRefresh();
    $("app").hidden = true;
    $("gone").hidden = false;
    setStatus("wait", "No disponible");
  }

  function stopRefresh() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function fetchTracking() {
    return fetch(SUPABASE_URL + "/rest/v1/rpc/get_tracking", {
      method: "POST",
      headers: {
        "apikey": ANON_KEY,
        "Authorization": "Bearer " + ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_token: token }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function ensureMap() {
    if (map) return;
    map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.on("zoomend", syncTimeLabels);
    $("center").addEventListener("click", fitAll);
  }

  function syncTimeLabels() {
    $("map").classList.toggle("hide-times", map.getZoom() < TIMES_MIN_ZOOM);
  }

  function fitAll() {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 17);
      return;
    }
    var b = L.latLngBounds(points.map(function (p) { return [p.lat, p.lng]; }));
    map.fitBounds(b, { padding: [48, 48], maxZoom: 17 });
  }

  function pinIcon(n, text, isLast, live) {
    var cls = "pin" + (isLast ? " is-last" : "") + (isLast && live ? " is-live" : "");
    var el = document.createElement("div");
    el.className = cls;
    var t = document.createElement("span");
    t.className = "pin-time";
    t.textContent = text;
    var num = document.createElement("span");
    num.className = "pin-num";
    num.textContent = String(n);
    el.appendChild(t);
    el.appendChild(num);
    return L.divIcon({ className: "pin-wrap", html: el, iconSize: [0, 0] });
  }

  function render(data) {
    ensureMap();

    points = (data.points || []).map(function (p) {
      return { lat: Number(p.lat), lng: Number(p.lng), acc: p.acc, t: new Date(p.t) };
    }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); });

    var live = !!data.live;
    var expires = new Date(data.expires_at);
    var started = new Date(data.started_at);

    if (live) setStatus("live", "En vivo");
    else setStatus("stopped", "Seguimiento detenido");

    var note = "Guardia activada el " + fmtFull.format(started) + ". ";
    note += live
      ? "La página se actualiza sola cada 20 segundos. "
      : "La persona ya no está compartiendo su ubicación. ";
    note += "Este enlace deja de funcionar el " + fmtFull.format(expires) + ".";
    $("note").textContent = note;

    // Sin cambios en los puntos no se redibuja nada (no mueve el mapa del
    // usuario ni le cierra la lista).
    var sig = points.length + "|" + (points.length ? points[points.length - 1].t.getTime() : 0) + "|" + live;
    var changed = sig !== lastSignature;
    lastSignature = sig;

    var last = points[points.length - 1];
    if (!last) {
      $("last-time").textContent = "Sin puntos todavía";
      $("last-ago").textContent = live ? "Esperando la primera ubicación…" : "";
      $("gmaps").hidden = true;
      $("count").textContent = "0 puntos";
      layer.clearLayers();
      if (firstFit) { map.setView([4.6, -74.1], 5); firstFit = false; }
      return;
    }

    var multiDay = !sameDay(points[0].t, last.t);
    $("last-time").textContent = fmtFull.format(last.t);
    $("last-ago").textContent = ago(last.t) +
      (last.acc != null ? " · precisión ±" + last.acc + " m" : "");
    $("gmaps").hidden = false;
    $("gmaps").href = "https://www.google.com/maps/search/?api=1&query=" +
      last.lat + "," + last.lng;
    $("count").textContent = points.length + (points.length === 1 ? " punto" : " puntos");

    if (!changed) return;

    layer.clearLayers();
    markers = [];

    if (points.length > 1) {
      L.polyline(points.map(function (p) { return [p.lat, p.lng]; }), {
        color: "#dc2626", weight: 4, opacity: 0.75
      }).addTo(layer);
    }

    if (last.acc != null && last.acc > 0) {
      L.circle([last.lat, last.lng], {
        radius: last.acc, color: "#dc2626", weight: 1, fillOpacity: 0.08
      }).addTo(layer);
    }

    var list = $("list");
    list.textContent = "";

    points.forEach(function (p, i) {
      var isLast = i === points.length - 1;
      var text = label(p.t, multiDay);
      var m = L.marker([p.lat, p.lng], {
        icon: pinIcon(i + 1, text, isLast, live),
        zIndexOffset: isLast ? 1000 : i,
        keyboard: false
      }).addTo(layer);
      markers.push(m);

      var li = document.createElement("li");
      if (isLast) li.className = "is-last";
      var n = document.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1);
      var body = document.createElement("div");
      var t = document.createElement("div");
      t.className = "t";
      t.textContent = fmtFull.format(p.t) + (isLast ? " · última" : "");
      var sub = document.createElement("div");
      sub.className = "muted";
      sub.textContent = p.acc != null ? "precisión ±" + p.acc + " m" : "";
      body.appendChild(t);
      body.appendChild(sub);
      li.appendChild(n);
      li.appendChild(body);
      li.addEventListener("click", function () { map.setView([p.lat, p.lng], 17); });
      list.appendChild(li);
    });

    if (firstFit) { fitAll(); firstFit = false; }
    syncTimeLabels();
  }

  function load() {
    fetchTracking().then(function (data) {
      if (!data || typeof data !== "object") { showGone(); return; }
      if (data.server_now) clockOffset = new Date(data.server_now).getTime() - Date.now();
      $("gone").hidden = true;
      $("app").hidden = false;
      render(data);
      if (map) map.invalidateSize();
      if (data.live) schedule();
    }).catch(function () {
      // Red caida: se conserva lo ultimo que se vio y se reintenta.
      if ($("app").hidden) setStatus("offline", "Sin conexión");
      else setStatus("offline", "Reconectando…");
      schedule();
    });
  }

  function schedule() {
    stopRefresh();
    timer = setTimeout(load, REFRESH_MS);
  }

  // Al volver a la pestana se actualiza enseguida, sin esperar el ciclo.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && timer) { stopRefresh(); load(); }
  });

  window.addEventListener("hashchange", function () { location.reload(); });

  if (!token) showGone();
  else load();
})();
