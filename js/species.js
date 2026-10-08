// Ecology page: plant search/browse, tree of life, animals, the guide's other page sections, and the shared sheet viewer.
const $ = (s) => document.querySelector(s);
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let species = [];
let byName = new Map(); // normalized scientific / common name / alias -> plant
let counts = {};        // plant id -> number of tagged trees on the camp map
let tab = "plants";
let built = false;
let viewerList = [];

// Entry kinds in species.json: (none) = plant sheet, "reference" = leaf guide page, "animal" = species on a wildlife page,
// "page" = a whole non-plant page grouped by `section`. Animals and pages are never part of the tree of life.
const TABS = [
  { id: "plants", label: "Plants", search: "Search plants by name, scientific name, genus, family or order…" },
  { id: "tree", label: "Tree of life", search: "Filter the tree by name, family, order…" },
  { id: "animals", label: "Animals", search: "Search animals by name, scientific name or group…" },
  { id: "sites", label: "Sites" },
  { id: "carbon", label: "Carbon capture" },
  { id: "maps", label: "Maps" },
];
const IN_TAB = {
  plants: (s) => !s.kind || s.kind === "reference",
  tree: (s) => !s.kind,
  animals: (s) => s.kind === "animal",
};
const listFor = (t) => species.filter(IN_TAB[t] || ((s) => s.kind === "page" && s.section === t));

// Common names for the plant families on the sheets (the first word is what chips and search use).
const FAMILY_COMMON = {
  Sapindaceae: "Maple", Rosaceae: "Rose", Betulaceae: "Birch", Salicaceae: "Willow", Juglandaceae: "Walnut", Malvaceae: "Mallow",
  Fagaceae: "Beech", Oleaceae: "Olive", Cupressaceae: "Cypress", Pinaceae: "Pine", Anacardiaceae: "Sumac", Vitaceae: "Grape",
};
const FAMILY_ALSO = { Sapindaceae: "soapberry", Malvaceae: "basswood linden" }; // extra search words only
const GYMNO = ["Pinales", "Cupressales"];
const pad = (n) => String(n).padStart(2, "0");
const sheetUrl = (s) => `img/sheets/p${pad(s.page)}.jpg`;
const thumbUrl = (s) => `img/thumbs/p${pad(s.page)}.jpg`;
const href = (id) => `#/ecology?${tab !== "plants" ? `tab=${tab}&` : ""}id=${id}`;

export const ready = (async () => {
  species = await (await fetch("data/species.json")).json();
  for (const s of species) {
    if (s.kind || !s.scientific) continue;
    s.genus = s.scientific.split(" ")[0];
    s.group = GYMNO.includes(s.order) ? "Gymnosperms" : "Angiosperms";
    s.familyCommon = FAMILY_COMMON[s.family] ? `${FAMILY_COMMON[s.family]} family` : "";
    for (const n of [s.common, s.scientific, ...(s.aliases || [])]) if (!byName.has(norm(n))) byName.set(norm(n), s);
  }
  for (const s of species) s.hay = [s.common, s.scientific, s.genus, s.family, s.familyCommon, FAMILY_ALSO[s.family], s.order, s.group, ...(s.aliases || []), s.keywords].filter(Boolean).join(" ").toLowerCase();
  const trees = await (await fetch("data/trees.geojson")).json();
  for (const f of trees.features) {
    const s = speciesForTree(f.properties.common, f.properties.scientific);
    if (s) counts[s.id] = (counts[s.id] || 0) + 1;
  }
})();

/** Species sheet for a tree record, or undefined. Scientific name wins: the shapefile's common names are less reliable
 *  (e.g. tag 83 is "Trembling Aspen" but Populus deltoides = Eastern Cottonwood, which is how the printed map colors it). */
export function speciesForTree(common, scientific) {
  return byName.get(norm(scientific)) || byName.get(norm(common));
}

function build() {
  built = true;
  $("#eco-tabs").innerHTML = TABS.map((t) => `<button data-tab="${t.id}">${t.label}</button>`).join("");
  $("#eco-tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) location.hash = `#/ecology${b.dataset.tab === "plants" ? "" : `?tab=${b.dataset.tab}`}`;
  };
  $("#chips").onclick = (e) => { const c = e.target.closest("[data-q]"); if (c) { $("#q").value = c.dataset.q; render(); } };
  $("#q").oninput = render;
  $("#viewer").onclick = (e) => { if (e.target.closest("#v-close") || e.target.classList.contains("viewer-body")) close(); };
  $("#v-prev").onclick = () => step(-1);
  $("#v-next").onclick = () => step(1);
  document.addEventListener("keydown", (e) => {
    if ($("#viewer").hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
}

const matches = (list) => {
  const toks = $("#q").value.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((s) => toks.every((t) => s.hay.includes(t)));
};

/** Filter chips under the search box: plant families by common name, or animal groups. */
function chipLabels() {
  if (tab === "animals") return ["Amphibians", "Birds", "Insects"];
  const fams = [...new Set(listFor("tree").map((s) => s.familyCommon).filter(Boolean))];
  return fams.sort();
}

function card(s) {
  const sub = s.kind === "reference" ? `Reference · p.${s.page}` : s.kind === "page" ? `Page ${s.page}`
    : `${s.familyCommon ? `${esc(s.familyCommon)} (${esc(s.family)})` : esc(s.family)}${counts[s.id] ? ` · ${counts[s.id]} on camp map` : ""}`;
  return `<a class="card" href="${href(s.id)}"><img loading="lazy" src="${thumbUrl(s)}" alt=""><div><b>${esc(s.common)}</b>` +
    (s.scientific ? `<i>${esc(s.scientific)}</i>` : "") + `<small>${sub}</small></div></a>`;
}

function render() {
  const t = TABS.find((x) => x.id === tab);
  const searchable = !!t.search;
  document.querySelectorAll("#eco-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $(".species-head").hidden = !searchable;
  $("#q").placeholder = t.search || "";
  $("#chips").hidden = !searchable;
  $("#chips").innerHTML = searchable ? chipLabels().map((l) => `<button class="chip" data-q="${esc(l)}">${esc(l)}</button>`).join("") + `<button class="chip" data-q="">Show all</button>` : "";
  $("#browse").hidden = tab === "tree";
  $("#tree").hidden = tab !== "tree";

  const all = listFor(tab);
  const list = searchable ? matches(all) : all;
  if (tab === "tree") {
    const nested = {};
    for (const s of list) ((((nested[s.group] ??= {})[s.order] ??= {})[s.family] ??= {})[s.genus] ??= []).push(s);
    const open = $("#q").value.trim() !== "";
    $("#tree").innerHTML = `<div class="tools"><button data-open="1">Expand all</button><button data-open="0">Collapse all</button></div>` + node(nested, 0, open);
    $("#tree").onclick = (e) => {
      const b = e.target.closest("[data-open]");
      if (b) $("#tree").querySelectorAll("details").forEach((d) => (d.open = b.dataset.open === "1"));
    };
    viewerList = [...document.querySelectorAll("#tree a.sp")].map((a) => species.find((s) => s.id === a.dataset.id));
  } else if (tab === "animals") {
    viewerList = species.filter((s) => s.kind === "page" && s.section === "animals");
    $("#browse").innerHTML = `<div class="grid">${viewerList.map(card).join("")}</div>` +
      `<div class="count">${list.length} of ${all.length} animal species</div>` +
      `<table class="animals"><thead><tr><th>Species</th><th>Scientific name</th><th>Group</th><th>Page</th></tr></thead><tbody>` +
      list.map((s) => `<tr><td><a href="${href(s.id)}">${esc(s.common)}</a></td><td><i>${esc(s.scientific)}</i></td><td>${esc(s.group)}</td><td>p.${s.page}</td></tr>`).join("") +
      `</tbody></table>`;
  } else {
    viewerList = list;
    $("#browse").innerHTML = (tab === "maps" ? `<p class="note">Looking for the interactive map? <a href="#/map">Open the camp map</a>.</p>` : "") +
      (searchable ? `<div class="count">${list.length} of ${all.length} sheets</div>` : "") + `<div class="grid">${list.map(card).join("")}</div>`;
  }
}

const LEVELS = ["Group", "Order", "Family", "Genus"];
function node(obj, depth, open) {
  if (depth === 4) return obj.sort((a, b) => a.scientific.localeCompare(b.scientific)).map((s) => `<a class="sp" data-id="${s.id}" href="${href(s.id)}">${esc(s.common)} <i>${esc(s.scientific)}</i></a>`).join("");
  return Object.keys(obj).sort().map((k) => `<details${open || depth < 1 ? " open" : ""}><summary><span class="lvl l${depth}">${LEVELS[depth]}</span>${esc(k)}</summary>${node(obj[k], depth + 1, open)}</details>`).join("");
}

function show(id) {
  const e = species.find((s) => s.id === id);
  let i = viewerList.findIndex((s) => s.id === id);
  if (i < 0 && e) i = viewerList.findIndex((s) => s.page === e.page); // e.g. an animal species -> its wildlife page
  if (i < 0) { viewerList = species; i = species.findIndex((s) => s.id === id); } // deep link while filtered out
  const s = viewerList[i];
  if (!s) return close();
  $("#v-img").src = sheetUrl(s);
  $("#v-img").alt = s.common;
  $("#v-title").innerHTML = `<b>${esc(s.common)}</b>${s.scientific && !s.kind ? ` <i>${esc(s.scientific)}</i> · ${esc(s.family)}` : ""} · p.${s.page}`;
  $("#viewer").hidden = false;
  $("#viewer").dataset.i = i;
}

const base = () => `#/ecology${tab !== "plants" ? `?tab=${tab}` : ""}`;
const close = () => { if (!$("#viewer").hidden) location.hash = base(); };
const step = (d) => {
  const n = viewerList.length;
  location.replace(href(viewerList[(+$("#viewer").dataset.i + d + n) % n].id));
};

/** Called on every route change to #/ecology[?tab=...][&id=...]. */
export async function syncSpecies(params) {
  await ready;
  if (!built) build();
  const want = params.get("view") === "tree" ? "tree" : params.get("tab");
  const next = TABS.some((t) => t.id === want) ? want : "plants";
  if (next !== tab) $("#q").value = ""; // chips and placeholder differ per tab
  tab = next;
  render();
  const id = params.get("id");
  if (id) show(id); else $("#viewer").hidden = true;
}
