# ScanWorld

**ScanBench** is a point cloud workbench that runs entirely in the browser. Nothing is uploaded: files are read on your own computer.

This repository holds the source, a build script and a GitHub Pages workflow that publishes a **test deployment** on every push to `main`.

> Beta software. The bundled samples are synthetic test data. The Mundaring Weir sample is a simulation styled on the real dam, not survey data.

## Try it

- **Hosted test site:** `https://stuartcbuckett-code.github.io/ScanWorld/` once GitHub Pages is switched on (see below).
- **Locally:**

  ```bash
  npm ci
  python3 build.py        # writes dist/
  npm run serve           # http://localhost:8080
  ```

  `python3 build.py --single` also writes `dist/ScanBench.html`, a single self-contained file you can open from disk (it loads three.js from a CDN and cannot load the built-in samples from `file://`).

### Switching on GitHub Pages (one time)

1. Repository **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open the **Actions** tab and re-run "Build and deploy test site" (or push any commit).

Pages on a private repository needs a paid GitHub plan; on a public repository it is free.

## What it does

| Area | Features |
|---|---|
| Formats | E57, LAS/LAZ 1.0–1.4, PLY, XYZ/CSV/PTS in; LAS, PLY, CSV, DXF, LandXML, KML, shapefile, DEM grid out; STL/OBJ/DXF design overlays |
| Viewing | Octree level of detail, point budget, eye-dome lighting, clipping box, class filter, Earth globe when a map grid is set |
| Datasets | Unlimited points: one-time conversion to an octree in browser storage, streamed into view; every source header, VLR and attribute kept and re-exportable |
| Measure | Point, distance, height, polyline, area, angle, plane dip, stockpile volume, line of sight, viewshed; names, notes, tags, colours |
| Edit | Box/polygon/freehand select, extract, delete, export a section, subsample, outlier filter, remove people, classify (ground, trees, buildings, roads; plant and structure by type) |
| Compare / register | Cloud to cloud, cloud to mesh, change between captures, point-pair and ICP alignment |
| Scan to CAD | Pipes, bends, flanges, steel sections (AS/NZS 3679.1), handrails, pressure vessels, cabinets; extract by picking 2 points; edit, move, delete; batch over a whole project; scan vs CAD report; DXF + schedule |
| Topo | Ground filter, TIN, contours, breaklines, trees, buildings, poles, spot levels; DXF, LandXML, PNEZD |
| Coordinates | GDA94/GDA2020, MGA94/MGA2020 zones 49–56, Perth and other WA project grids (PCG94/PCG2020…), local grids |
| Review | Annotations, saved views with clip, flight paths with video recording, project file, projects and sub-projects |

## Layout

```
src/            application source (plain JavaScript, no framework)
  io.js           readers and writers            algo.js   KD-tree, ICP, compare, rasters
  cad.js          Scan to CAD engine             topo.js   topographic engine
  crs.js          coordinate systems             app*.js   user interface modules
  shell.html      page markup and styles         land-50m.json  world outline for the globe
build.py        bundles everything into dist/
samples/        synthetic sample clouds (LAZ parts) and their truth tables
tools/          Python generators for the samples (numpy, laspy, pye57)
test/           engine tests (node) and a browser smoke test (Playwright)
docs/           design notes
```

## Tests

```bash
npm test                                   # engine + sample checks (node only)
npx playwright install chromium            # once, for the browser test
npm run build && npm run serve &           # serve dist/ on :8080
NODE_PATH=$(npm root -g) node test/browser_smoke.js
```

## Status and known limits

- Scan to CAD detection is a starting point for review, not a finished model: expect false and missed items, and check sizes (channel sections in particular).
- Dataset import has been tested to 13.5 million points; multi-gigabyte files, E57 sources and cloud hosting are not yet tested.
- Recording, large exports and local-folder datasets work best in Chrome or Edge.
