# ScanBench LOD project format (version 1)

A project is a folder. It can live on a local disk, a network share, or any web host that supports HTTP range requests (Amazon S3, Azure Blob, Cloudflare R2, GitHub Pages, `scanlod view`).

```
MyProject/
  project.json        the management file: datasets, annotations, measurements, views, boxes, models
  dataset.json        one converted dataset (more can sit in sub-folders)
  hierarchy.bin       the tile index, in pages
  octree.bin          the tiles
  models/pipe.stl     STL/OBJ models referenced by project.json
  ScanBench.html      the viewer, set to open this project (served: opens at once; from disk: one click to allow the folder)
  scanlod.log         the converter's log
```

The viewer never reads `octree.bin` whole. It reads the first index page, then only the pages and tiles that the current view needs, with byte-range reads.

## project.json

Written by `scanlod convert` (if missing) and by the viewer's **Save project**. Coordinates are world coordinates (the dataset's coordinate system), never the viewer's local origin.

```json
{
  "format": "scanbench-project", "version": 1, "name": "Mundaring Weir",
  "crs": "MGA2020-50",
  "datasets": [
    { "id": "d1", "name": "Mundaring Weir", "path": "dataset.json", "visible": true, "group": "g0", "color": "rgb" },
    { "id": "d2", "name": "2026 re-scan", "path": "rescan/dataset.json", "visible": false }
  ],
  "annotations":  [ { "title": "Crack", "note": "…", "tags": ["defect"], "color": "#ff7a3d", "position": [421561.2, 6463791.8, 151.3] } ],
  "measurements": [ { "name": "Crest length", "type": "distance", "values": ["…"], "points": [[…], […]], "tags": [], "color": "#ffcc00" } ],
  "views":        [ { "name": "Spillway", "tags": [], "view": { "target": [E, N, Z], "dist": 85, "yaw": 1.2, "pitch": 0.4, "ortho": false }, "clip": { "min": [E, N, Z], "max": [E, N, Z] } } ],
  "boxes":        [ { "name": "Valve house", "min": [E, N, Z], "max": [E, N, Z], "note": "" } ],
  "models":       [ { "id": "m1", "name": "Outlet pipe", "path": "models/outlet.stl", "offset": [E, N, Z], "rotation": 0, "scale": 0.001, "visible": true, "color": "#c9ced6", "opacity": 0.55 } ],
  "tags": [], "groups": [], "flights": [], "cad": null
}
```

* `datasets[].path` is relative to project.json. Several datasets can be open together and switched on and off.
* `models[]`: an STL (binary or ASCII) or OBJ file, relative to project.json. Placement is `world = rotateZ(rotation°) · (vertex × scale) + offset`; use `scale` 0.001 for a model drawn in millimetres.
* `views[]` keep the camera and the clip box; `boxes[]` are named 3D boxes for export or extraction.
* `cad` holds Scan to CAD results in the same form as the stand-alone ScanBench project file.

## dataset.json

Written once by the converter; the viewer treats it as read-only.

| key | meaning |
|---|---|
| `format`, `version` | `"scanbench-lod"`, `1` |
| `points`, `nodes`, `depth` | totals |
| `scale`, `offset` | the integer grid: `world = offset + integer × scale` |
| `bounds` | tight world bounds of the points |
| `cube` | the octree cube: `min` (world), `size` (metres), `units` (integer units, a power of two) |
| `spacing` | point spacing of the root tile, in metres |
| `crs` | `{ "id": "MGA2020-50", "epsg": 7850, "wkt": "…", "vertical": { "datum": "AHD", "geoid": "AUSGeoid2020", "epsg": 5711 } }`, from the sources or chosen when converting; null for local coordinates. `vertical.datum` is `ellipsoid` or `AHD` |
| `attributes` | the columns stored for every point, in order (see below) |
| `encoding` | `"gzip"` or `"none"` (per tile) |
| `octree`, `hierarchy` | file names, sizes, `firstChunkSize`, `stepSize` (levels per index page) |
| `sources[]` | one per LAS/LAZ file or E57 scan: label, file, point count, a checksum, and all source metadata: LAS header (raw), version, point format, scale/offset, system identifier, software, date, every VLR and EVLR (raw, base64); for E57 the scan name, GUID, pose, sensor details and acquisition times |
| `files[]` | file-level E57 metadata (GUID, coordinate metadata, the XML section when small) |
| `settings` | the converter settings used |

## Tiles (octree.bin)

Node names: `r` is the root; each child adds one digit `x | y<<1 | z<<2` (1 = upper half). A node's cube follows from its name and `cube.units`.

Each tile is a block of columns, one column per attribute component, in the order of `attributes` (gzip-compressed when `encoding` is gzip):

| attribute | type | components |
|---|---|---|
| position | uint32 | 3: x, y, z as an integer offset from the tile's minimum corner |
| intensity | uint16 | 1 |
| rgb | uint16 | 3 |
| classification | uint8 | 1 |
| return_number, number_of_returns | uint8 | 1 each |
| flags | uint8 | 1 (bit 0 synthetic, 1 key-point, 2 withheld, 3 overlap, 4 scan direction, 5 edge of flight line) |
| scanner_channel, user_data | uint8 | 1 each |
| scan_angle | int16 | 1 (0.006° units) |
| point_source_id | uint16 | 1 |
| gps_time | float64 | 1 |
| source | uint16 | 1 (index into `sources`) |

Only attributes that some source actually uses are stored. World position of a point: `offset + (tileMin + value) × scale`. Every source point is stored in exactly one tile, unchanged; `scanlod verify` proves it against checksums taken during conversion.

## Tile index (hierarchy.bin)

Pages of 22-byte entries, as in Potree 2. A page lists a subtree `stepSize` levels deep in breadth-first order; children follow their parent in the order of the set bits of its child mask.

| bytes | field |
|---|---|
| 0 | type: 0 inner, 1 leaf, 2 proxy |
| 1 | child mask |
| 2–5 | point count (uint32) |
| 6–13 | byte offset (uint64) |
| 14–21 | byte size (uint64) |

For inner and leaf entries, offset and size locate the tile in octree.bin. A proxy entry sits on a page's last level and points (offset, size) at the page that starts with that node. The first page starts at 0 and is `hierarchy.firstChunkSize` bytes.
