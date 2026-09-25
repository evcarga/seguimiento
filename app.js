/* Sentinel - pagina de seguimiento.
 *
 * Lo unico que esta pagina puede pedir es get_tracking(token): coordenadas y
 * hora de los puntos de UNA guardia y su posicion en vivo. La anon key es
 * publica por diseno (va tambien dentro de la app) y no da acceso a ninguna
 * tabla: todo pasa por esa funcion, que valida el token y su vencimiento.
 *
 * Mientras el seguimiento esta en vivo se consulta cada 2 s, pidiendo solo lo
 * nuevo (p_after): el telefono sube su posicion cada 2 s despues de la alerta.
 */
(function () {
  "use strict";

  var SUPABASE_URL = "https://oxzhmeeyiesflhhhehpa.supabase.co";
  var ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94emhtZWV5aWVzZmxoaGhlaHBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MzQyMjEsImV4cCI6MjEwNDMxMDIyMX0.iwAwe-sylkP8HYQ8OhH4TRMveaX4GjVMEArxkItsosE";
  var REFRESH_MS = 2000;          // en vivo, pestana visible
  var REFRESH_HIDDEN_MS = 10000;  // pestana en segundo plano
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
  var layer = null;       // marcadores numerados
  var trailLine = null;   // linea del recorrido
  var liveMarker = null;  // "Ahora": posicion en vivo
  var accCircle = null;
  var markers = [];
  var points = [];
  // Con puntos cada pocos segundos, todas las etiquetas dirian la misma hora y
  // taparian los numeros: solo lleva etiqueta el primer punto de cada minuto
  // (y siempre el ultimo). La lista conserva la hora exacta con segundos.
  var showLabel = [];
  var lastShownText = null;
  var livePos = null;
  var isLive = false;
  var lastT = null;       // hora (texto ISO) del ultimo punto recibido
  var clockOffset = 0;    // servidor - dispositivo, para el "hace X s"
  var timer = null;
  var firstFit = true;
  var followLive = true;  // el mapa sigue a la persona hasta que el usuario lo mueva
  var multiDay = false;
  var placeholder = false;

  // Todas las horas en hora de Colombia, sin importar la zona del telefono o
  // computador que abra el enlace.
  var TZ = "America/Bogota";
  var fmtTime = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: true
  });
  var fmtTimeSec = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
  });
  var fmtDay = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ, day: "2-digit", month: "short"
  });
  var fmtFull = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hour12: true
  });
  var fmtShort = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit",
    minute: "2-digit", hour12: true
  });
  var fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
  });

  function sameDay(a, b) {
    return fmtDate.format(a) === fmtDate.format(b);
  }

  function label(date) {
    return multiDay ? fmtDay.format(date) + " " + fmtTime.format(date) : fmtTime.format(date);
  }

  function ago(date) {
    var s = Math.max(0, Math.round((Date.now() + clockOffset - date.getTime()) / 1000));
    if (s < 60) return "hace " + s + " s";
    var m = Math.floor(s / 60);
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
      body: JSON.stringify({ p_token: token, p_after: lastT }),
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
    trailLine = L.polyline([], { color: "#dc2626", weight: 4, opacity: 0.75 }).addTo(map);
    map.on("zoomend", syncTimeLabels);
    // Si la persona que mira arrastra el mapa, deja de seguir automaticamente.
    map.on("dragstart", function () { followLive = false; });
    $("center").addEventListener("click", function () { followLive = true; fitAll(); });
  }

  function syncTimeLabels() {
    $("map").classList.toggle("hide-times", map.getZoom() < TIMES_MIN_ZOOM);
  }

  function allLatLngs() {
    var ll = points.map(function (p) { return [p.lat, p.lng]; });
    if (livePos) ll.push([livePos.lat, livePos.lng]);
    return ll;
  }

  function fitAll() {
    var ll = allLatLngs();
    if (!ll.length) return;
    if (ll.length === 1) { map.setView(ll[0], 17); return; }
    map.fitBounds(L.latLngBounds(ll), { padding: [48, 48], maxZoom: 17 });
  }

  function pinIcon(n, text, isLast) {
    var el = document.createElement("div");
    el.className = "pin" + (isLast ? " is-last" : "");
    if (text) {
      var t = document.createElement("span");
      t.className = "pin-time";
      t.textContent = text;
      el.appendChild(t);
    }
    var num = document.createElement("span");
    num.className = "pin-num";
    num.textContent = String(n);
    el.appendChild(num);
    return L.divIcon({ className: "pin-wrap", html: el, iconSize: [0, 0] });
  }

  function liveIcon(text) {
    var el = document.createElement("div");
    el.className = "pin is-now" + (isLive ? " is-live" : "");
    var t = document.createElement("span");
    t.className = "pin-time";
    t.textContent = text;
    var num = document.createElement("span");
    num.className = "pin-num";
    num.textContent = "●";
    el.appendChild(t);
    el.appendChild(num);
    return L.divIcon({ className: "pin-wrap", html: el, iconSize: [0, 0] });
  }

  function listItem(p, i) {
    var li = document.createElement("li");
    var n = document.createElement("span");
    n.className = "n";
    n.textContent = String(i + 1);
    var body = document.createElement("div");
    var t = document.createElement("div");
    t.className = "t";
    t.textContent = fmtFull.format(p.t);
    var sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = p.acc != null ? "precisión ±" + p.acc + " m" : "";
    body.appendChild(t);
    body.appendChild(sub);
    li.appendChild(n);
    li.appendChild(body);
    li.addEventListener("click", function () {
      followLive = false;
      map.setView([p.lat, p.lng], 17);
    });
    return li;
  }

  // Agrega solo los puntos nuevos (no se redibuja todo cada 2 s).
  function addPoints(nuevos) {
    if (!nuevos.length) return;
    var list = $("list");

    // El que era el ultimo deja de serlo.
    if (markers.length) {
      var prevIdx = markers.length - 1;
      var prev = points[prevIdx];
      markers[prevIdx].setIcon(pinIcon(prevIdx + 1,
        showLabel[prevIdx] ? label(prev.t) : "", false));
      markers[prevIdx].setZIndexOffset(prevIdx);
      if (list.lastChild) list.lastChild.classList.remove("is-last");
    }

    nuevos.forEach(function (p) {
      points.push(p);
      var i = points.length - 1;
      var text = label(p.t);
      showLabel[i] = text !== lastShownText;
      if (showLabel[i]) lastShownText = text;
      var m = L.marker([p.lat, p.lng], {
        icon: pinIcon(i + 1, showLabel[i] ? text : "", false),
        zIndexOffset: i,
        keyboard: false
      }).addTo(layer);
      markers.push(m);
      list.appendChild(listItem(p, i));
    });

    var lastIdx = points.length - 1;
    var last = points[lastIdx];
    markers[lastIdx].setIcon(pinIcon(lastIdx + 1, label(last.t), true));
    markers[lastIdx].setZIndexOffset(1000);
    if (list.lastChild) list.lastChild.classList.add("is-last");
  }

  function parsePoint(p) {
    return { lat: Number(p.lat), lng: Number(p.lng), acc: p.acc, t: new Date(p.t), raw: p.t };
  }

  function render(data) {
    ensureMap();

    isLive = !!data.live;
    var expires = new Date(data.expires_at);
    var started = new Date(data.started_at);

    var nuevos = (data.points || []).map(parsePoint).filter(function (p) {
      return isFinite(p.lat) && isFinite(p.lng);
    });
    if (nuevos.length) lastT = nuevos[nuevos.length - 1].raw;

    if (!multiDay && (points.length || nuevos.length)) {
      var first = points.length ? points[0].t : nuevos[0].t;
      var lastNew = nuevos.length ? nuevos[nuevos.length - 1].t : points[points.length - 1].t;
      multiDay = !sameDay(first, lastNew);
    }
    addPoints(nuevos);

    livePos = data.live_pos ? parsePoint(data.live_pos) : null;
    var lastTrail = points[points.length - 1];
    // La posicion en vivo solo se muestra aparte si es mas nueva que el ultimo
    // punto numerado.
    if (livePos && lastTrail && livePos.t <= lastTrail.t) livePos = null;

    trailLine.setLatLngs(allLatLngs());

    var current = livePos || lastTrail;
    if (livePos) {
      var icon = liveIcon("Ahora " + fmtTimeSec.format(livePos.t));
      if (!liveMarker) {
        liveMarker = L.marker([livePos.lat, livePos.lng], {
          icon: icon, zIndexOffset: 2000, keyboard: false
        }).addTo(map);
      }
      liveMarker.setLatLng([livePos.lat, livePos.lng]);
      liveMarker.setIcon(icon);
    } else if (liveMarker) {
      map.removeLayer(liveMarker);
      liveMarker = null;
    }

    if (current && current.acc != null && current.acc > 0) {
      if (!accCircle) {
        accCircle = L.circle([current.lat, current.lng], {
          radius: current.acc, color: "#dc2626", weight: 1, fillOpacity: 0.08
        }).addTo(map);
      }
      accCircle.setLatLng([current.lat, current.lng]);
      accCircle.setRadius(current.acc);
    }

    if (isLive) setStatus("live", "En vivo");
    else setStatus("stopped", "Seguimiento detenido");

    // "p. m." ya termina en punto: no se agrega otro.
    var fin = function (txt) { return /\.$/.test(txt) ? txt : txt + "."; };
    var note = "Horas en hora de Colombia. " +
      fin("Guardia activada el " + fmtShort.format(started)) + " ";
    note += isLive
      ? "La ubicación se actualiza cada 2 segundos. "
      : "La persona ya no está compartiendo su ubicación. ";
    note += fin("Este enlace deja de funcionar el " + fmtShort.format(expires));
    $("note").textContent = note;

    $("count").textContent = points.length + (points.length === 1 ? " punto" : " puntos");

    if (!current) {
      $("last-time").textContent = "Sin puntos todavía";
      $("last-ago").textContent = isLive ? "Esperando la primera ubicación…" : "";
      $("gmaps").hidden = true;
      // Vista provisional de Colombia; firstFit sigue en true para acercarse
      // en cuanto llegue el primer punto.
      if (firstFit && !placeholder) { map.setView([4.6, -74.1], 5); placeholder = true; }
      return;
    }

    $("gmaps").hidden = false;
    $("gmaps").href = "https://www.google.com/maps/search/?api=1&query=" +
      current.lat + "," + current.lng;
    updateClock();

    if (firstFit) {
      fitAll();
      firstFit = false;
    } else if (isLive && followLive && !map.getBounds().pad(-0.15).contains([current.lat, current.lng])) {
      // Si la persona se sale de la vista, el mapa la sigue.
      map.panTo([current.lat, current.lng]);
    }
    syncTimeLabels();
  }

  // "hace 3 s" se actualiza cada segundo, sin pedir nada al servidor.
  function updateClock() {
    var lastTrail = points[points.length - 1];
    var current = livePos || lastTrail;
    if (!current) return;
    $("last-time").textContent = fmtFull.format(current.t);
    $("last-ago").textContent = ago(current.t) +
      (current.acc != null ? " · precisión ±" + current.acc + " m" : "");
  }
  setInterval(updateClock, 1000);

  function load() {
    fetchTracking().then(function (data) {
      if (!data || typeof data !== "object") { showGone(); return; }
      if (data.server_now) clockOffset = new Date(data.server_now).getTime() - Date.now();
      var wasHidden = $("app").hidden;
      $("gone").hidden = true;
      $("app").hidden = false;
      render(data);
      if (wasHidden) {
        // Leaflet mide el contenedor al crearse; se vuelve a medir cuando el
        // navegador termina de acomodar la pagina (si no, solo pinta una franja).
        map.invalidateSize();
        setTimeout(function () {
          map.invalidateSize();
          if (points.length || livePos) fitAll();
        }, 250);
      }
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
    var ms = document.visibilityState === "visible" ? REFRESH_MS : REFRESH_HIDDEN_MS;
    timer = setTimeout(load, ms);
  }

  // Al volver a la pestana se actualiza enseguida, sin esperar el ciclo.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && timer) { stopRefresh(); load(); }
  });

  window.addEventListener("hashchange", function () { location.reload(); });

  if (!token) showGone();
  else load();
})();
