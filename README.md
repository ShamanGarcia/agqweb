# Camp AGQ guide

Static web app: interactive camp map (2D/3D, toggleable layers), Ecology pages (plants, tree of life, animals, sites, carbon, maps) and a flip-book of the Camp AGQ Field Guide. Vanilla JS + MapLibre GL (CDN), no build step.

Run locally:

```
python -m http.server 5180
```

then open http://localhost:5180. It also works on any static host (e.g. GitHub Pages from the repo root).

Rebuild `data/` and `img/` from the source shapefiles and the guide PDF with `python tools/build_data.py` (needs Pillow and numpy; the source paths are set at the top of the script).
