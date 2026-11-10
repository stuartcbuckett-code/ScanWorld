See the Datasets section of the README for use. Design notes:

- One-time import streams any mix of LAS, LAZ, E57, PLY and XYZ into an octree in browser storage (OPFS). LAZ is decoded chunk by chunk from its chunk table, so file size does not matter.
- Layout per dataset: `metadata.json` (bounds, scale/offset, record layout, every source header + VLRs + EVLRs, node hierarchy) and `octree.bin` (points node by node; each point is the LAS record plus a 2-byte source index).
- Points are sampled Potree-style (one point per cell of a 128³ grid per node) and moved, never duplicated, so each source point is stored once and exports are lossless when all sources share a point format.
- The viewer asks only for `metadata.json` and byte ranges of `octree.bin`, so the same folder works from any static host with CORS and Range requests ("Open from URL").
- Known limits: import needs roughly 2–3× the dataset size in free browser storage while it runs; E57/PLY/XYZ sources are read whole; export is LAS (no LAZ/E57 writer yet); largest test so far is 13.5 M points.
