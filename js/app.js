import { syncSpecies } from "./species.js";
import { showMap } from "./map.js";
import { syncGuide } from "./guide.js";

const views = { map: "view-map", ecology: "view-ecology", guide: "view-guide" };

async function route() {
  const [path, qs] = (location.hash.slice(1) || "/map").split("?");
  const seg = path.split("/")[1];
  const page = seg === "ecology" || seg === "species" ? "ecology" : seg === "guide" ? "guide" : "map"; // #/species = old link for Ecology
  const params = new URLSearchParams(qs || "");
  for (const [k, id] of Object.entries(views)) document.getElementById(id).hidden = k !== page;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === page));
  if (page !== "ecology") document.getElementById("viewer").hidden = true;
  if (page !== "guide") syncGuide(null);
  if (page === "ecology") return syncSpecies(params);
  if (page === "guide") return syncGuide(params);
  return showMap();
}

addEventListener("hashchange", route);
route();
