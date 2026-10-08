// Field guide flip book: a closed book beside its table of contents; click either to zoom into a two-page spread
// (single page on narrow screens) with arrows to flip in both directions. Hash: #/guide (closed), #/guide?page=N (open).
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");
const src = (n) => `img/sheets/p${pad(n)}.jpg`;
const TOTAL = 52;               // pages in the guide
const LAST = 26;                // spreads: 0 = cover alone, 1..25 = (2,3)..(50,51), 26 = back cover alone
const FLIP_MS = 700;

let built = false, isOpen = false, single = false, busy = false;
let spread = 0, page = 1; // double mode tracks `spread`; single mode tracks `page`

const spreadOf = (n) => (n <= 1 ? 0 : n >= TOTAL ? LAST : Math.floor(n / 2));
const pagesOf = (s) => (s === 0 ? [null, 1] : s === LAST ? [TOTAL, null] : [2 * s, 2 * s + 1]);

function setPage(el, n) {
  el.style.visibility = n ? "visible" : "hidden";
  if (n) el.querySelector("img").src = src(n);
}

async function build() {
  built = true;
  const { toc } = await (await fetch("data/toc.json")).json();
  const items = toc.map((t) => `<li class="${t.sub ? "sub" : ""}"><a href="#/guide?page=${t.p}"><span>${t.t}</span><em>${t.p}</em></a></li>`).join("");
  $("#toc-list").innerHTML = items;
  $("#b-toc-list").innerHTML = items;
  $("#book-closed").onclick = () => (location.hash = "#/guide?page=1");
  $("#b-close").onclick = hide;
  $("#b-prev").onclick = () => flip(-1);
  $("#b-next").onclick = () => flip(1);
  $("#b-contents").onclick = () => $("#b-toc").classList.toggle("open");
  $("#b-toc-list").onclick = (e) => { if (e.target.closest("a")) $("#b-toc").classList.remove("open"); };
  $("#book-overlay").onclick = (e) => { if (e.target.id === "book-overlay" || e.target.classList.contains("b-stage")) hide(); };
  $("#spread").onclick = (e) => {
    const pg = e.target.closest(".pg");
    if (pg) flip(pg.classList.contains("l") ? -1 : 1);
  };
  document.addEventListener("keydown", (e) => {
    if (!isOpen) return;
    if (e.key === "Escape") hide();
    else if (e.key === "ArrowLeft") flip(-1);
    else if (e.key === "ArrowRight") flip(1);
  });
  addEventListener("resize", () => { if (isOpen && layoutMode()) render(); });
}

/** Single page on narrow/portrait screens, otherwise a two-page spread. Returns true if the mode changed. */
function layoutMode() {
  const next = innerWidth < 760 || innerWidth / innerHeight < 1.05;
  const changed = next !== single;
  single = next;
  $("#book-overlay").classList.toggle("single", single);
  return changed;
}

const focusPage = () => (single ? page : pagesOf(spread)[0] || pagesOf(spread)[1]);

/** Draw the current state with no animation. */
function render() {
  const left = $("#spread .pg.l"), right = $("#spread .pg.r");
  const [l, r] = pagesOf(spread);
  if (single) {
    setPage(right, page);
    setPage(left, null);
  } else {
    setPage(left, l);
    setPage(right, r);
  }
  $("#spread").classList.toggle("shift-r", !single && spread === 0);
  $("#spread").classList.toggle("shift-l", !single && spread === LAST);
  $("#b-count").textContent = single ? `Page ${page} of ${TOTAL}` : spread === 0 ? "Cover" : spread === LAST ? "Back cover" : `Pages ${l}–${r} of ${TOTAL}`;
  $("#b-prev").disabled = single ? page <= 1 : spread <= 0;
  $("#b-next").disabled = single ? page >= TOTAL : spread >= LAST;
  history.replaceState(null, "", `#/guide?page=${focusPage()}`);
  // warm the cache for the next/previous pages
  for (const n of single ? [page - 1, page + 1] : [...pagesOf(Math.max(0, spread - 1)), ...pagesOf(Math.min(LAST, spread + 1))]) if (n >= 1 && n <= TOTAL) new Image().src = src(n);
}

function flip(dir) {
  if (busy || !isOpen) return;
  if (single) {
    const n = page + dir;
    if (n < 1 || n > TOTAL) return;
    page = n;
    spread = spreadOf(n);
    const r = $("#spread .pg.r");
    r.style.setProperty("--dir", dir);
    r.classList.remove("slide");
    void r.offsetWidth; // restart the animation
    r.classList.add("slide");
    return render();
  }
  const to = spread + dir;
  if (to < 0 || to > LAST) return;
  busy = true;
  const [l0, r0] = pagesOf(spread), [l1, r1] = pagesOf(to);
  const left = $("#spread .pg.l"), right = $("#spread .pg.r"), leaf = $("#leaf");
  // The turning leaf carries the old page on its front and the new page on its back; the page under it is already the new one.
  if (dir > 0) { setPage(left, l0); setPage(right, r1); setPage($("#leaf .front"), r0); setPage($("#leaf .back"), l1); }
  else { setPage(left, l1); setPage(right, r0); setPage($("#leaf .front"), l0); setPage($("#leaf .back"), r1); }
  leaf.className = `leaf ${dir > 0 ? "fwd" : "bwd"}`;
  leaf.hidden = false;
  $("#spread").classList.toggle("shift-r", to === 0);
  $("#spread").classList.toggle("shift-l", to === LAST);
  void leaf.offsetWidth;
  leaf.classList.add("go");
  setTimeout(() => {
    spread = to;
    page = focusPage();
    leaf.hidden = true;
    leaf.className = "leaf";
    render();
    busy = false;
  }, FLIP_MS + 40);
}

function showBook(n) {
  const wasOpen = isOpen;
  isOpen = true;
  layoutMode();
  page = n;
  spread = spreadOf(n);
  const overlay = $("#book-overlay");
  if (!wasOpen) {
    // zoom out of the closed book: animate from its position on the page
    const r = $("#book-closed").getBoundingClientRect();
    overlay.style.setProperty("--ox", `${r.left + r.width / 2}px`);
    overlay.style.setProperty("--oy", `${r.top + r.height / 2}px`);
    overlay.hidden = false;
    overlay.classList.remove("zoom");
    void overlay.offsetWidth;
    overlay.classList.add("zoom");
  }
  $("#b-toc").classList.remove("open");
  busy = false;
  $("#leaf").hidden = true;
  render();
}

function hide() {
  if (!isOpen) return;
  isOpen = false;
  $("#book-overlay").hidden = true;
  history.replaceState(null, "", "#/guide");
}

/** Route hook: params = URLSearchParams on #/guide, or null when navigating to another page. */
export async function syncGuide(params) {
  if (!params) { if (isOpen) { isOpen = false; $("#book-overlay").hidden = true; } return; }
  if (!built) await build();
  const n = parseInt(params.get("page"), 10);
  if (n >= 1 && n <= TOTAL) showBook(n); else if (isOpen) hide();
}
