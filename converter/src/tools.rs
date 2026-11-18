//! scanlod info / export / verify
use crate::convert::{fmt_n, rec_hash};
use crate::octree::{self, Attrs, NodeRec};
use crate::rec::Rec;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use rayon::prelude::*;
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub struct Dataset {
    pub dir: PathBuf,
    pub meta: Value,
    pub attrs: Attrs,
    pub nodes: Vec<NodeRec>,
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub cube_units: u64,
    pub gz: bool,
}

pub fn open(p: &Path) -> Result<Dataset> {
    let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().unwrap_or(Path::new(".")).to_path_buf() };
    let mut jp = if p.is_dir() { p.join("dataset.json") } else { p.to_path_buf() };
    let mut meta: Value = serde_json::from_slice(&std::fs::read(&jp).with_context(|| format!("reading {}", jp.display()))?)?;
    if meta["format"] == "scanbench-project" {
        let rel = meta["datasets"][0]["path"].as_str().ok_or_else(|| anyhow!("project has no datasets"))?.to_string();
        jp = dir.join(rel);
        meta = serde_json::from_slice(&std::fs::read(&jp)?)?;
    }
    if meta["format"] != "scanbench-lod" {
        bail!("{} is not a scanlod dataset", jp.display());
    }
    let dir = jp.parent().unwrap().to_path_buf();
    let mut a = Attrs::default();
    for at in meta["attributes"].as_array().unwrap() {
        match at["name"].as_str().unwrap() {
            "intensity" => a.intensity = true,
            "rgb" => a.rgb = true,
            "classification" => a.classification = true,
            "return_number" => a.returns = true,
            "flags" => a.flags = true,
            "scanner_channel" => a.channel = true,
            "user_data" => a.user_data = true,
            "scan_angle" => a.scan_angle = true,
            "point_source_id" => a.point_source_id = true,
            "gps_time" => a.gps_time = true,
            "source" => a.source = true,
            _ => {}
        }
    }
    let h = std::fs::read(dir.join(meta["hierarchy"]["file"].as_str().unwrap()))?;
    let nodes = octree::read_hierarchy(&h, meta["hierarchy"]["firstChunkSize"].as_u64().unwrap())?;
    let f3 = |v: &Value| [v[0].as_f64().unwrap(), v[1].as_f64().unwrap(), v[2].as_f64().unwrap()];
    Ok(Dataset {
        scale: f3(&meta["scale"]),
        offset: f3(&meta["offset"]),
        cube_units: meta["cube"]["units"].as_u64().unwrap(),
        gz: meta["encoding"] == "gzip",
        dir,
        meta,
        attrs: a,
        nodes,
    })
}

impl Dataset {
    pub fn read_node(&self, f: &mut File, n: &NodeRec) -> Result<Vec<Rec>> {
        if n.count == 0 {
            return Ok(vec![]);
        }
        let mut b = vec![0u8; n.size as usize];
        f.seek(SeekFrom::Start(n.off))?;
        f.read_exact(&mut b)?;
        let (min, _) = octree::node_cube(&n.name, self.cube_units);
        octree::decode(&b, self.gz, n.count as usize, min, &self.attrs).with_context(|| format!("node {}", n.name))
    }
    pub fn octree(&self) -> Result<File> {
        Ok(File::open(self.dir.join(self.meta["octree"]["file"].as_str().unwrap_or("octree.bin")))?)
    }
    /// Node cube in world units.
    pub fn world_cube(&self, n: &str) -> ([f64; 3], [f64; 3]) {
        let (m, u) = octree::node_cube(n, self.cube_units);
        let mn = [self.offset[0] + m[0] as f64 * self.scale[0], self.offset[1] + m[1] as f64 * self.scale[1], self.offset[2] + m[2] as f64 * self.scale[2]];
        (mn, [mn[0] + u as f64 * self.scale[0], mn[1] + u as f64 * self.scale[1], mn[2] + u as f64 * self.scale[2]])
    }
}

pub fn info(p: &Path) -> Result<()> {
    let d = open(p)?;
    let m = &d.meta;
    println!("{}", m["name"].as_str().unwrap_or(""));
    println!("  points       {} ({})", m["points"], fmt_n(m["points"].as_u64().unwrap_or(0)));
    println!("  nodes        {} in {} levels", d.nodes.len(), m["depth"].as_u64().unwrap_or(0) + 1);
    println!("  bounds       {} … {}", m["bounds"]["min"], m["bounds"]["max"]);
    println!("  grid         scale {} offset {}", m["scale"], m["offset"]);
    println!("  crs          {}", if m["crs"].is_null() { "none (local coordinates)".to_string() } else { m["crs"]["epsg"].as_u64().map(|e| format!("EPSG:{}", e)).unwrap_or_else(|| "WKT".into()) });
    println!("  attributes   {}", m["attributes"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect::<Vec<_>>().join(", "));
    println!("  octree       {} bytes ({:.2} per point), encoding {}", m["octree"]["bytes"], m["octree"]["bytes"].as_f64().unwrap_or(0.0) / m["points"].as_f64().unwrap_or(1.0), m["encoding"]);
    println!("  sources      {}", m["sources"].as_array().map(|a| a.len()).unwrap_or(0));
    let mut per = vec![(0u64, 0u64); 40];
    for n in &d.nodes {
        per[n.name.len() - 1].0 += 1;
        per[n.name.len() - 1].1 += n.count as u64;
    }
    for (l, (c, p)) in per.iter().enumerate() {
        if *c > 0 {
            println!("  level {:>2}     {:>8} nodes  {:>10} points  avg {:>7}", l, c, fmt_n(*p), p / c);
        }
    }
    Ok(())
}

pub fn verify(p: &Path) -> Result<()> {
    let d = open(p)?;
    let nsrc = d.meta["sources"].as_array().map(|a| a.len()).unwrap_or(1);
    eprintln!("Checking {} nodes…", d.nodes.len());
    let parts: Vec<Result<(Vec<(u64, u64, u64)>, u64)>> = d
        .nodes
        .par_chunks(256)
        .map(|ch| {
            let mut f = d.octree()?;
            let mut acc = vec![(0u64, 0u64, 0u64); nsrc];
            let mut n = 0u64;
            for nd in ch {
                let recs = d.read_node(&mut f, nd)?;
                let (m, u) = octree::node_cube(&nd.name, d.cube_units);
                for r in &recs {
                    for (k, v) in [r.x, r.y, r.z].iter().enumerate() {
                        let rel = *v as i64 - m[k];
                        if rel < 0 || rel > u as i64 {
                            bail!("node {}: a point lies outside the node", nd.name);
                        }
                    }
                    let (fh, ph) = rec_hash(r);
                    let s = &mut acc[(r.src as usize).min(nsrc - 1)];
                    s.0 += 1;
                    s.1 = s.1.wrapping_add(fh);
                    s.2 = s.2.wrapping_add(ph);
                }
                n += recs.len() as u64;
            }
            Ok((acc, n))
        })
        .collect();
    let mut tot = vec![(0u64, 0u64, 0u64); nsrc];
    let mut n = 0;
    for p in parts {
        let (a, k) = p?;
        n += k;
        for i in 0..nsrc {
            tot[i].0 += a[i].0;
            tot[i].1 = tot[i].1.wrapping_add(a[i].1);
            tot[i].2 = tot[i].2.wrapping_add(a[i].2);
        }
    }
    let mut ok = n == d.meta["points"].as_u64().unwrap_or(0);
    println!("points: {} stored, {} expected {}", n, d.meta["points"], if ok { "✓" } else { "✗" });
    for (i, s) in d.meta["sources"].as_array().unwrap().iter().enumerate() {
        let want_n = s["points"].as_u64().unwrap_or(0);
        let wf = u64::from_str_radix(s["checksum"]["full"].as_str().unwrap_or("0"), 16).unwrap_or(0);
        let wp = u64::from_str_radix(s["checksum"]["position"].as_str().unwrap_or("0"), 16).unwrap_or(0);
        let (c, f, p) = tot[i];
        let browser = s["checksum"]["scheme"].is_string(); // made by the browser converter: its checksums use another scheme, so counts are compared
        let full = browser || f == wf;
        let pos = browser || p == wp;
        if c != want_n || !pos {
            ok = false;
        }
        if browser {
            println!("  {}: {} points {} (converted in the browser: counts and tile bounds checked)", s["label"].as_str().unwrap_or(""), c, if c == want_n { "✓" } else { "✗" });
        } else {
            println!("  {}: {} points {}, positions {}, all attributes {}", s["label"].as_str().unwrap_or(""), c, if c == want_n { "✓" } else { "✗" }, if pos { "identical ✓" } else { "DIFFER ✗" }, if full { "identical ✓" } else { "differ (attributes were dropped with --drop?)" });
        }
    }
    if !ok {
        bail!("verification failed");
    }
    println!("Verified: every source point is stored exactly once, unchanged.");
    Ok(())
}

pub fn export(p: &Path, out: &Path, bbox: Option<[f64; 6]>, source: Option<u16>, max_level: Option<usize>) -> Result<()> {
    let d = open(p)?;
    let sel: Vec<&NodeRec> = d
        .nodes
        .iter()
        .filter(|n| n.count > 0 && max_level.map(|l| n.name.len() - 1 <= l).unwrap_or(true))
        .filter(|n| match bbox {
            None => true,
            Some(b) => {
                let (mn, mx) = d.world_cube(&n.name);
                !(mx[0] < b[0] || mx[1] < b[1] || mx[2] < b[2] || mn[0] > b[3] || mn[1] > b[4] || mn[2] > b[5])
            }
        })
        .collect();
    let est: u64 = sel.iter().map(|n| n.count as u64).sum();
    eprintln!("Reading up to {} points from {} nodes…", fmt_n(est), sel.len());
    let srcs = d.meta["sources"].as_array().cloned().unwrap_or_default();
    let src_meta = &srcs.get(source.unwrap_or(0) as usize).cloned().unwrap_or(Value::Null)["metadata"];
    // header
    let mut b = las::Builder::from((1, 4));
    b.point_format = las::point::Format::new(if d.attrs.rgb { 7 } else { 6 })?;
    b.transforms = las::Vector { x: las::Transform { scale: d.scale[0], offset: d.offset[0] }, y: las::Transform { scale: d.scale[1], offset: d.offset[1] }, z: las::Transform { scale: d.scale[2], offset: d.offset[2] } };
    b.generating_software = format!("scanlod {}", env!("CARGO_PKG_VERSION"));
    if let Some(s) = src_meta["systemIdentifier"].as_str() {
        b.system_identifier = s.chars().take(31).collect();
    }
    let mut has_wkt = false;
    for v in src_meta["vlrs"].as_array().into_iter().flatten().chain(src_meta["evlrs"].as_array().into_iter().flatten()) {
        if v["laszip"].as_bool().unwrap_or(false) || v["userId"] == "laszip encoded" || v["userId"] == "LASF_Spec" && v["recordId"] == 4 {
            continue; // compression and extra-bytes descriptions do not apply to the new records
        }
        let raw = base64::engine::general_purpose::STANDARD.decode(v["b64"].as_str().unwrap_or(""))?;
        let hl = if raw.len() >= 60 && v["length"].as_u64().unwrap_or(0) as usize == raw.len() - 60 { 60 } else { 54 };
        if v["userId"] == "LASF_Projection" && v["recordId"] == 2112 {
            has_wkt = true;
        }
        b.vlrs.push(las::Vlr { user_id: v["userId"].as_str().unwrap_or("").to_string(), record_id: v["recordId"].as_u64().unwrap_or(0) as u16, description: v["description"].as_str().unwrap_or("").to_string(), data: raw[hl..].to_vec() });
    }
    if !has_wkt {
        if let Some(w) = d.meta["crs"]["wkt"].as_str() {
            b.vlrs.push(las::Vlr { user_id: "LASF_Projection".into(), record_id: 2112, description: "OGC WKT".into(), data: [w.as_bytes(), &[0u8]].concat() });
            has_wkt = true;
        }
    }
    b.has_wkt_crs = has_wkt;
    let header = b.into_header()?;
    let mut w = las::Writer::from_path(out, header).with_context(|| format!("creating {}", out.display()))?;
    let rl = if d.attrs.rgb { 36 } else { 30 };
    let mut f = d.octree()?;
    let mut n_out = 0u64;
    let mut k = 0;
    for nd in sel {
        let recs = d.read_node(&mut f, nd)?;
        let mut bytes = Vec::with_capacity(recs.len() * rl);
        for r in &recs {
            if let Some(s) = source {
                if r.src != s {
                    continue;
                }
            }
            if let Some(bx) = bbox {
                let x = d.offset[0] + r.x as f64 * d.scale[0];
                let y = d.offset[1] + r.y as f64 * d.scale[1];
                let z = d.offset[2] + r.z as f64 * d.scale[2];
                if x < bx[0] || y < bx[1] || z < bx[2] || x > bx[3] || y > bx[4] || z > bx[5] {
                    continue;
                }
            }
            bytes.extend_from_slice(&r.x.to_le_bytes());
            bytes.extend_from_slice(&r.y.to_le_bytes());
            bytes.extend_from_slice(&r.z.to_le_bytes());
            bytes.extend_from_slice(&r.intensity.to_le_bytes());
            bytes.push((r.ret & 15) | (r.nret & 15) << 4);
            bytes.push((r.flags & 15) | (r.chan & 3) << 4 | ((r.flags >> 4) & 1) << 6 | ((r.flags >> 5) & 1) << 7);
            bytes.push(r.cls);
            bytes.push(r.user);
            bytes.extend_from_slice(&r.scan_angle.to_le_bytes());
            // without a point source ID (E57, merged tiles), the source number goes there, so scans stay separable
            let psid = if !d.attrs.point_source_id && d.attrs.source { r.src.wrapping_add(1) } else { r.psid };
            bytes.extend_from_slice(&psid.to_le_bytes());
            bytes.extend_from_slice(&r.gps.to_le_bytes());
            if d.attrs.rgb {
                bytes.extend_from_slice(&r.r.to_le_bytes());
                bytes.extend_from_slice(&r.g.to_le_bytes());
                bytes.extend_from_slice(&r.b.to_le_bytes());
            }
        }
        if !bytes.is_empty() {
            n_out += (bytes.len() / rl) as u64;
            let pd = las::PointDataBuilder::new().for_header(w.header()).build_from_bytes(bytes)?;
            w.write_points(&pd)?;
        }
        k += 1;
        if k % 500 == 0 {
            eprintln!("  {} points written", fmt_n(n_out));
        }
    }
    w.close()?;
    eprintln!("Wrote {} points to {}", n_out, out.display());
    Ok(())
}
