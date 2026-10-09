// Camp map: MapLibre GL, one map with 2D (flat) and 3D (terrain + extrusions) modes and toggleable layers.
import { esc, speciesForTree, ready } from "./species.js";

const SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const NAMES = ["property", "trails", "buildings", "trees", "activity_areas", "areas"];

// Layer panel entries. ids: always; d2/d3: only in that mode; off: hidden until switched on. (Campsites intentionally not included.)
const GROUPS = [
  { key: "activity_areas", label: "Activity areas", color: "#ffffff", ids: ["act-circle", "act-label"] },
  { key: "buildings", label: "Buildings", color: "#02724e", ids: ["bld-label"], d2: ["bld-fill", "bld-line"], d3: ["bld-ext"] },
  { key: "trails", label: "Trails", color: "#e2e2e2", ids: ["trails-casing", "trails"] },
  { key: "trees", label: "Trees", color: "#9f050f", ids: ["trees-label"], d2: ["trees-circle", "trees-star"], d3: ["trees-3d"] },
  { key: "property", label: "Property border", color: "#ffe14d", ids: ["property-line"] },
  { key: "areas", label: "Areas", color: "#d8d79e", ids: ["areas-fill", "areas-line", "areas-label"] },
  { key: "elevation", label: "Elevation", color: "linear-gradient(#bd894e, #f3f3ca, #4da0aa)", ids: ["elev-img"], off: true },
];
const CLICKABLE = ["trees-circle", "trees-3d", "act-circle", "bld-fill", "bld-ext", "areas-fill"];

// Zone fills sampled from the printed zone map (field guide p.45).
const AREA_COLORS = {
  "Downstairs camp": "#89ce64", "Upstairs Camp": "#d8d79e", "Waterfront": "#bce5e9", "Wetland Forest": "#b5d89e",
  "Aspen Maple Forest": "#a2d9b2", "Hemlock Pine Forest": "#6c9b7b", "Mixed Hardwood Forest": "#b5e188",
};

// Colors below were sampled from the printed camp maps (field guide pp. 46-47); species colors live in species.json.
const BUILDING_COLORS = [
  [/^(cabin|gc$|\d+$)|library/i, "#02724e"],
  [/bathhouse/i, "#257400"],
  [/lodge|dining|rowe/i, "#ffffff"],
  [/kitchen/i, "#fcebc0"],
  [/biggie/i, "#c1e9ff"],
  [/^yc$/i, "#fffc91"],
  [/funk/i, "#ae5a2b"],
  [/woodshop/i, "#b3582b"],
  [/archery/i, "#f27f7a"],
  [/riflery/i, "#ffc271"],
  [/barn/i, "#b83a3b"],
  [/climbing/i, "#e8a8a8"],
];
const buildingColor = (name = "") => (BUILDING_COLORS.find(([re]) => re.test(name)) || [, "#e2e2e2"])[1]; // boat shed, maintenance, old infirmary
const NEUTRAL_TREE = "#9a9a9a"; // trees with no species recorded
const DBH = ["coalesce", ["get", "dbh"], 8];
const treeSpecies = new Map(); // species -> number of trees on the map (for the legend)

let map, bounds, mode = "2d";
const on = Object.fromEntries(GROUPS.map((g) => [g.key, !g.off]));

const flat = (c) => (typeof c[0] === "number" ? [c] : c.flatMap(flat));
const disc = ([lon, lat], r, n = 12) => {
  const dLat = r / 111320, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  return { type: "Polygon", coordinates: [Array.from({ length: n + 1 }, (_, i) => [lon + dLon * Math.cos((2 * Math.PI * i) / n), lat + dLat * Math.sin((2 * Math.PI * i) / n)])] };
};

/** Tag each tree with its species color/sheet and champion flag, and build trunk/crown cylinders for 3D (heights are estimates from dbh). */
function prepTrees(fc) {
  const solid = { type: "FeatureCollection", features: [] };
  const largest = new Map(); // species id -> its biggest tree
  for (const f of fc.features) {
    const p = f.properties, sp = speciesForTree(p.common, p.scientific);
    p.color = sp?.color || NEUTRAL_TREE;
    if (!sp) continue;
    p.sheet = sp.id;
    p.sci = sp.scientific;
    treeSpecies.set(sp, (treeSpecies.get(sp) || 0) + 1);
    if ((p.dbh || 0) > (largest.get(sp.id)?.dbh || 0)) largest.set(sp.id, p);
  }
  // Champions: the largest tree of each species; the six biggest of those get a star (as on the printed map).
  [...largest.values()].sort((a, b) => b.dbh - a.dbh).slice(0, 6).forEach((p) => (p.champion = 1));
  for (const f of fc.features) {
    const p = f.properties;
    const dbh = p.dbh || 8, h = Math.min(28, 4 + 0.8 * dbh);
    solid.features.push(
      { type: "Feature", properties: { ...p, color: "#6b4a2f", base: 0, top: h * 0.5 }, geometry: disc(f.geometry.coordinates, Math.max(0.2, (dbh * 0.0254) / 2)) },
      { type: "Feature", properties: { ...p, base: h * 0.45, top: h }, geometry: disc(f.geometry.coordinates, Math.min(6, 1.2 + 0.1 * dbh)) });
  }
  return solid;
}

function popupHtml(layer, p) {
  if (layer.startsWith("trees")) {
    const link = p.sheet ? `<p><a href="#/ecology?id=${esc(p.sheet)}">View field guide sheet &rarr;</a></p>` : "";
    return `<h3>${esc(p.common || "Unidentified tree")}</h3>` + (p.sci || p.scientific ? `<p><i>${esc(p.sci || p.scientific)}</i></p>` : "") +
      `<p>${[p.tag ? `Tag #${esc(p.tag)}` : "", p.dbh ? `DBH ${esc(p.dbh)} in` : ""].filter(Boolean).join(" · ")}</p>` + (p.champion ? `<p>&#9733; Champion: largest of its species</p>` : "") + link;
  }
  if (layer.startsWith("areas")) return `<h3>${esc(p.name)}</h3>`;
  const year = +p.year > 0 ? `<p>Built ${esc(p.year)}</p>` : "";
  return `<h3>${esc(p.name || "Building")}</h3>${year}`;
}

function applyVisibility() {
  const set = (ids = [], v) => ids.forEach((id) => map.setLayoutProperty(id, "visibility", v ? "visible" : "none"));
  for (const g of GROUPS) {
    set(g.ids, on[g.key]);
    set(g.d2, on[g.key] && mode === "2d");
    set(g.d3, on[g.key] && mode === "3d");
  }
}

function setMode(m) {
  mode = m;
  map.setTerrain(m === "3d" ? { source: "dem", exaggeration: 1.2 } : null);
  map.easeTo({ pitch: m === "3d" ? 65 : 0, bearing: m === "3d" ? -25 : 0, duration: 1200 });
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  applyVisibility();
}

/** White five-point star with a dark outline: readable on both dark and light tree colors. */
function starImage(size = 64) {
  const g = Object.assign(document.createElement("canvas"), { width: size, height: size }).getContext("2d");
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = size * (i % 2 ? 0.2 : 0.44), a = (Math.PI / 5) * i - Math.PI / 2;
    g[i ? "lineTo" : "moveTo"](size / 2 + r * Math.cos(a), size / 2 + r * Math.sin(a));
  }
  g.closePath();
  Object.assign(g, { fillStyle: "#fff", strokeStyle: "#222", lineWidth: size / 12, lineJoin: "round" });
  g.fill();
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

function buildLegend() {
  const rows = [...treeSpecies].sort((a, b) => b[1] - a[1]).map(([s, n]) => `<div class="lg"><i style="background:${s.color}"></i>${esc(s.common)} <small>${n}</small></div>`);
  rows.push(`<div class="lg"><i style="background:${NEUTRAL_TREE}"></i>Species not recorded</div>`, `<div class="lg"><b>&#9733;</b> Champion: largest of its species (top six)</div>`);
  document.getElementById("legend-body").innerHTML = rows.join("") + `<p class="hint">Circle size = trunk diameter (DBH).</p>`;
}

async function init() {
  const [data, , elev] = await Promise.all([Promise.all(NAMES.map((n) => fetch(`data/${n}.geojson`).then((r) => r.json()))), ready, fetch("data/elevation.json").then((r) => r.json())]);
  const src = Object.fromEntries(NAMES.map((n, i) => [n, data[i]]));
  const pts = src.property.features.flatMap((f) => flat(f.geometry.coordinates));
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];

  map = new maplibregl.Map({
    container: "map",
    bounds,
    fitBoundsOptions: { padding: 30 },
    maxPitch: 75,
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        sat: { type: "raster", tiles: [SAT], tileSize: 256, maxzoom: 19, attribution: "Imagery &copy; Esri" },
        dem: { type: "raster-dem", tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: "terrarium", attribution: "Terrain: Mapzen/AWS" },
      },
      layers: [{ id: "bg", type: "background", paint: { "background-color": "#e4e8d8" } }, { id: "sat", type: "raster", source: "sat" }],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }));
  window.campMap = map; // handy for debugging in the console
  map.on("error", (e) => console.warn("map:", e.sourceId || "", e.error?.message || e.error));

  // The container can be 0x0 at construction (pane not laid out yet), so fit to the property on first real size.
  const el = map.getContainer();
  const fit = new ResizeObserver(() => {
    if (!el.clientWidth || !el.clientHeight) return;
    map.fitBounds(bounds, { padding: 30, duration: 0 });
    fit.disconnect();
  });
  fit.observe(el);

  map.on("load", () => {
    // These must run before addSource: sources serialize their data when added.
    const trees3d = prepTrees(src.trees);
    for (const f of src.buildings.features) f.properties.color = buildingColor(f.properties.name);
    for (const f of src.areas.features) f.properties.color = AREA_COLORS[f.properties.name] || "#cccccc";
    buildLegend();
    map.addImage("star", starImage());
    for (const n of NAMES) map.addSource(n, { type: "geojson", data: src[n] });
    map.addSource("trees3d", { type: "geojson", data: trees3d });
    map.addSource("elevation", { type: "image", url: "data/elevation.png", coordinates: elev.coordinates }); // TL, TR, BR, BL
    const label = { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12 };
    const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.4 };
    // Ground layers first (they sit under everything else): elevation relief, zone fills.
    map.addLayer({ id: "elev-img", type: "raster", source: "elevation", paint: { "raster-opacity": 0.85, "raster-resampling": "linear" } });
    map.addLayer({ id: "areas-fill", type: "fill", source: "areas", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.4 } });
    map.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": "#fff", "line-opacity": 0.9, "line-width": 1.5 } });
    map.addLayer({
      id: "areas-label", type: "symbol", source: "areas", minzoom: 14,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"], "text-size": 13, "text-max-width": 6 },
      paint: { "text-color": "#26372c", "text-halo-color": "#fff", "text-halo-width": 1.6 },
    });
    map.addLayer({ id: "property-line", type: "line", source: "property", paint: { "line-color": "#ffe14d", "line-width": 3, "line-dasharray": [3, 2] } });
    map.addLayer({ id: "trails-casing", type: "line", source: "trails", paint: { "line-color": "#000", "line-opacity": 0.55, "line-width": 5.5 } });
    map.addLayer({ id: "trails", type: "line", source: "trails", paint: { "line-color": "#e2e2e2", "line-width": 3 } });
    map.addLayer({ id: "bld-fill", type: "fill", source: "buildings", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.95 } });
    map.addLayer({ id: "bld-line", type: "line", source: "buildings", paint: { "line-color": "#2f3b33", "line-width": 1 } });
    map.addLayer({ id: "bld-ext", type: "fill-extrusion", source: "buildings", paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": 5, "fill-extrusion-base": 0 } });
    map.addLayer({ id: "bld-label", type: "symbol", source: "buildings", minzoom: 15, layout: { ...label, "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 18, 13], "text-max-width": 7 }, paint: halo }); // collision handling thins them out when zoomed out
    // Trees: fill = species color, size = trunk diameter (DBH), black outline, as on the printed map. Biggest drawn first so small trees stay visible.
    map.addLayer({
      id: "trees-circle", type: "circle", source: "trees", layout: { "circle-sort-key": ["-", DBH] },
      paint: {
        "circle-color": ["get", "color"], "circle-stroke-color": "#000", "circle-stroke-width": 1,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, ["max", 3, ["*", 0.12, DBH]], 20, ["max", 4, ["*", 0.6, DBH]]],
      },
    });
    map.addLayer({
      id: "trees-star", type: "symbol", source: "trees", filter: ["==", ["get", "champion"], 1],
      layout: { "icon-image": "star", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 15, ["*", 0.002, DBH], 20, ["*", 0.0102, DBH]] },
    });
    map.addLayer({
      id: "trees-label", type: "symbol", source: "trees", minzoom: 17,
      layout: { "text-field": ["to-string", ["get", "tag"]], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-variable-anchor": ["bottom", "top", "left", "right"], "text-radial-offset": ["+", 0.7, ["*", 0.05, DBH]] },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.5 },
    });
    map.addLayer({ id: "trees-3d", type: "fill-extrusion", source: "trees3d", paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-base": ["get", "base"], "fill-extrusion-height": ["get", "top"] } });
    map.addLayer({ id: "act-circle", type: "circle", source: "activity_areas", paint: { "circle-color": "#fff", "circle-radius": 5, "circle-stroke-color": "#646369", "circle-stroke-width": 1.5 } });
    map.addLayer({ id: "act-label", type: "symbol", source: "activity_areas", layout: { ...label, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: halo });
    syncPanel(); // applies visibility + sets the "All layers" state
  });

  const hits = (pt) => map.queryRenderedFeatures(pt, { layers: CLICKABLE.filter((id) => map.getLayoutProperty(id, "visibility") !== "none") });
  map.on("click", (e) => {
    const f = hits(e.point)[0];
    if (!f) return;
    const html = f.layer.id === "act-circle"
      ? `<h3>${esc(f.properties.name)}</h3><p>${esc(f.properties.description)}</p>`
      : popupHtml(f.layer.id, f.properties);
    new maplibregl.Popup({ offset: 10 }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
  map.on("mousemove", (e) => (map.getCanvas().style.cursor = hits(e.point).length ? "pointer" : ""));

  // panel
  const layersEl = document.getElementById("layers");
  const ramp = elev.ramp.map(([p, c]) => `${c} ${p * 100}%`).join(", ");
  layersEl.innerHTML = `<label class="row all"><input type="checkbox" data-all><b>All layers</b></label>` + GROUPS.map((g) => `<label class="row"><input type="checkbox" data-k="${g.key}"${on[g.key] ? " checked" : ""}><span class="sw" style="background:${g.color}"></span>${g.label}</label>`).join("") +
    `<div class="elev-legend" id="elev-legend" hidden><div class="bar" style="background:linear-gradient(to right, ${ramp})"></div><div class="lab"><span>${Math.round(elev.min)} ${elev.unit}</span><span>${Math.round(elev.max)} ${elev.unit}</span></div></div>`;
  const syncPanel = () => {
    const n = GROUPS.filter((g) => on[g.key]).length, all = layersEl.querySelector("[data-all]");
    layersEl.querySelectorAll("[data-k]").forEach((c) => (c.checked = on[c.dataset.k]));
    all.checked = n === GROUPS.length;
    all.indeterminate = n > 0 && n < GROUPS.length; // some on, some off
    document.getElementById("elev-legend").hidden = !on.elevation;
    applyVisibility();
  };
  layersEl.onchange = (e) => {
    if (e.target.dataset.all !== undefined) GROUPS.forEach((g) => (on[g.key] = e.target.checked));
    else on[e.target.dataset.k] = e.target.checked;
    syncPanel();
  };
  document.getElementById("mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); };
  document.getElementById("basemap").onchange = (e) => map.setLayoutProperty("sat", "visibility", e.target.value === "sat" ? "visible" : "none");
  if (innerWidth < 700) document.getElementById("panel").open = false;
}

let starting;
export async function showMap() {
  if (!starting) starting = init();
  await starting;
  map.resize();
}
