# scanlod: the ScanBench LOD converter

`scanlod` turns E57, LAS and LAZ scans of any size into a tiled octree with a JSON index. The ScanBench viewer then streams it: only the tiles in view are loaded, at the level of detail the view needs, within a fixed point and memory budget. A 250 GB scan opens as quickly as a small one.

It is one program with no installer. It also carries the viewer inside, so `scanlod view` opens a project on your own computer with nothing else installed.

## Download

Builds for Windows, Linux and macOS are attached to the **scanlod-latest** release on GitHub (built automatically from `main`), or build it yourself (below).

## Quick start (Windows)

```
scanlod-windows-x64.exe convert D:\Scans\site.e57 -o D:\Projects\Site
scanlod-windows-x64.exe view D:\Projects\Site
```

The first command converts; the second starts a local viewer and opens your browser. Annotations, measurements, saved views, boxes and STL models you add are saved back into `D:\Projects\Site\project.json`.

Several inputs become one dataset, and folders are searched for `.e57`, `.las` and `.laz` files:

```
scanlod convert D:\Scans\tiles -o D:\Projects\Corridor --name "Corridor 2026"
scanlod convert scan1.e57 scan2.e57 -o Plant --crs EPSG:7850
```

## Commands

| command | does |
|---|---|
| `convert <inputs…> -o <folder>` | builds the dataset (`dataset.json`, `hierarchy.bin`, `octree.bin`) and a starter `project.json` |
| `view <folder>` | serves the viewer and the project on `http://127.0.0.1:8765` and opens the browser |
| `export <folder> -o out.laz [--box=minE,minN,minZ,maxE,maxN,maxZ] [--source N]` | writes LAS or LAZ at full resolution: everything, a 3D box, or one source |
| `verify <folder>` | proves every source point is stored exactly once and unchanged |
| `info <folder>` | summary: points, levels, attributes, sources, size per level |

## Sizing a big conversion

The defaults adapt to the data and the computer: threads = all cores, memory = 60% of RAM, processing chunks sized to fit memory, counting grid 128³/256³/512³ by point count. Override them when needed:

| option | use it to |
|---|---|
| `--memory 24` | set the memory to use, in GB |
| `--threads 12` | limit or raise the worker threads |
| `--temp E:\scratch` | put temporary files on another drive (they need about 40 bytes per point) |
| `--preset fine` / `coarse` | smaller tiles (smoother over slow links) or bigger tiles (fewer requests) |
| `--node-points`, `--sample-grid`, `--chunk-points`, `--count-grid` | fine control of the tiling |
| `--compression 0-9` | gzip level per tile (0 = none, default 4) |
| `--scale 0.0005` | coordinate precision in metres (default: the finest LAS scale, 0.1 mm for E57) |
| `--drop gps_time,user_data` | leave attributes out to save space |
| `--crs EPSG:7850` | set the coordinate system when the sources have none |
| `--dry-run` | read headers, print the plan and the disk check, and stop |
| `--resume` | continue an interrupted run from its last finished chunk |

Disk space: plan for the temporary chunk files (about 40 bytes per point, removed as each chunk finishes) plus the output (about 13–20 bytes per point with gzip). The converter checks free space before it starts.

Resuming: if a run stops (power cut, out of disk), run the same command with `--resume`. Finished chunks are kept, and the run continues from where it stopped.

## What is kept

* **Every point, unchanged:** positions on the source's integer grid, and intensity, RGB, classification, return numbers, flags, scanner channel, user data, scan angle, point source ID and GPS time. Each point is stored exactly once (`verify` checks this against checksums taken while converting).
* **All source metadata, in `dataset.json`:**
  * LAS: the raw header, every VLR and EVLR, and the coordinate system (WKT or GeoTIFF keys).
  * E57: each scan's name, GUID, pose, sensor, acquisition times, intensity and colour limits, and the file's GUID, coordinate metadata and XML.
* **Exports:** `export` and the viewer's export write LAS 1.4 with the source's VLRs, so the coordinate system travels with the data.
* **Not stored:** waveform packets, NIR and LAS extra bytes (they are listed in `dataset.json`). E57 points with no valid position are skipped and counted.

## Speed

The two read passes are bound by LAZ/E57 decoding and run on all cores. Measured on a 2-core cloud machine (7.6 GB RAM):

| data | points | time | peak memory |
|---|---|---|---|
| Mundaring Weir sample, 4 LAZ files | 2.6 M | 7 s | 0.2 GB |
| 3 E57 scans with poses | 3 M | 4 s | 0.2 GB |
| synthetic survey, 6 LAZ tiles (each 40 M points), 2.7 GB | 240 M | 6 min 2 s | 1.7 GB |

On that machine the 240 M run used 9.4 GB of temporary disk at peak and wrote a 4.1 GB octree (17 bytes per point, all attributes kept). `verify` read it all back in 21 s.

Throughput scales with cores: both read passes and the octree build run on every core. For a 250 GB LAZ survey (about 20–30 billion points), expect a few hours on an 8–16 core workstation with 32 GB of memory and a fast SSD for the temporary files. To estimate your own run, start it and watch the counting rate it prints in the first minute.

## Format

See [docs/lod-format.md](../docs/lod-format.md). It is an open, simple format (JSON plus two binary files), modelled on Potree 2's paged hierarchy.

## Build

```
npm ci && python3 build.py          # builds the viewer that scanlod carries
cargo build --release --manifest-path converter/Cargo.toml
```
