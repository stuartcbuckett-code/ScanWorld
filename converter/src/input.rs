//! Finding inputs, reading their metadata, and streaming their points as `Rec`s on the dataset grid.
use crate::rec::Rec;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Las,
    E57,
}

/// Which attributes a source can carry.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Has {
    pub intensity: bool,
    pub rgb: bool,
    pub gps: bool,
    pub las: bool, // classification, returns, flags, user data, scan angle, point source id
}

/// One source of points: a LAS/LAZ file, or one scan inside an E57 file.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct Source {
    pub path: PathBuf,
    pub kind: Kind,
    pub scan: usize, // E57 scan index
    pub label: String,
    pub points: u64,
    pub bytes: u64,
    pub bounds: Option<[f64; 6]>, // minx miny minz maxx maxy maxz, world
    pub scale: Option<[f64; 3]>,
    pub offset: Option<[f64; 3]>,
    pub has: Has,
    pub meta: Value,
    pub crs: Option<Value>,
    pub pose: Option<([f64; 4], [f64; 3])>, // quaternion w x y z, translation
}

/// A piece of work for one thread: a range of points of one source.
#[derive(Clone, Debug)]
pub struct Unit {
    pub src: usize,
    pub start: u64,
    pub count: u64,
}

/// The dataset grid: world = offset + int * scale.
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub offset: [f64; 3],
    pub scale: [f64; 3],
}

pub fn find_inputs(args: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut out = vec![];
    fn walk(p: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        if p.is_dir() {
            let mut ents: Vec<_> = std::fs::read_dir(p)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            ents.sort();
            for e in ents {
                walk(&e, out)?;
            }
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            let ext = ext.to_ascii_lowercase();
            if ext == "las" || ext == "laz" || ext == "e57" {
                out.push(p.to_path_buf());
            }
        }
        Ok(())
    }
    for a in args {
        if !a.exists() {
            bail!("Input not found: {}", a.display());
        }
        walk(a, &mut out)?;
    }
    if out.is_empty() {
        bail!("No .las, .laz or .e57 files found in the inputs.");
    }
    Ok(out)
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn le_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn le_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn le_u64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn le_f64(b: &[u8], o: usize) -> f64 {
    f64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn cstr(b: &[u8]) -> String {
    let e = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..e]).trim().to_string()
}

/// GeoTIFF key directory → EPSG codes.
fn geokeys(data: &[u8]) -> Value {
    let mut o = serde_json::Map::new();
    if data.len() < 8 {
        return Value::Object(o);
    }
    let n = le_u16(data, 6) as usize;
    for k in 0..n {
        let p = 8 + k * 8;
        if p + 8 > data.len() {
            break;
        }
        let (id, loc, _cnt, val) = (le_u16(data, p), le_u16(data, p + 2), le_u16(data, p + 4), le_u16(data, p + 6));
        if loc != 0 {
            continue;
        }
        match id {
            3072 => {
                o.insert("projected".into(), json!(val));
            }
            2048 => {
                o.insert("geographic".into(), json!(val));
            }
            4096 => {
                o.insert("vertical".into(), json!(val));
            }
            1024 => {
                o.insert("modelType".into(), json!(val));
            }
            _ => {}
        }
    }
    Value::Object(o)
}

fn read_las_meta(path: &Path) -> Result<Source> {
    let mut f = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let bytes = f.metadata()?.len();
    let mut h = vec![0u8; 375];
    let got = f.read(&mut h)?;
    if got < 227 || &h[0..4] != b"LASF" {
        bail!("{} is not a LAS/LAZ file", path.display());
    }
    let (vmaj, vmin) = (h[24], h[25]);
    let hsize = le_u16(&h, 94) as usize;
    let off_points = le_u32(&h, 96) as u64;
    let nvlr = le_u32(&h, 100) as usize;
    let pf_raw = h[104];
    let pf = pf_raw & 0x3f;
    let rec_len = le_u16(&h, 105);
    let legacy = le_u32(&h, 107) as u64;
    let n = if vmin >= 4 && got >= 255 && le_u64(&h, 247) > 0 { le_u64(&h, 247) } else { legacy };
    let scale = [le_f64(&h, 131), le_f64(&h, 139), le_f64(&h, 147)];
    let offset = [le_f64(&h, 155), le_f64(&h, 163), le_f64(&h, 171)];
    let (maxx, minx, maxy, miny, maxz, minz) = (le_f64(&h, 179), le_f64(&h, 187), le_f64(&h, 195), le_f64(&h, 203), le_f64(&h, 211), le_f64(&h, 219));
    let hdr = h[..hsize.min(got)].to_vec();
    // VLRs, raw
    f.seek(SeekFrom::Start(hsize as u64))?;
    let mut vlrs = vec![];
    let mut crs: Option<Value> = None;
    let mut wkt: Option<String> = None;
    let mut gk: Option<Value> = None;
    let mut pos = hsize as u64;
    for _ in 0..nvlr {
        if pos + 54 > off_points {
            break;
        }
        let mut vh = [0u8; 54];
        f.read_exact(&mut vh)?;
        let len = le_u16(&vh, 20) as usize;
        let mut data = vec![0u8; len];
        f.read_exact(&mut data)?;
        let user = cstr(&vh[2..18]);
        let rid = le_u16(&vh, 18);
        let desc = cstr(&vh[22..54]);
        if user == "LASF_Projection" && rid == 2112 {
            wkt = Some(cstr(&data));
        }
        if user == "LASF_Projection" && rid == 34735 {
            gk = Some(geokeys(&data));
        }
        let mut raw = vh.to_vec();
        raw.extend_from_slice(&data);
        vlrs.push(json!({"userId": user, "recordId": rid, "description": desc, "length": len, "laszip": user == "laszip encoded", "b64": b64(&raw)}));
        pos += 54 + len as u64;
    }
    // EVLRs, raw (LAS 1.4)
    let mut evlrs = vec![];
    if vmin >= 4 && got >= 247 {
        let start = le_u64(&h, 235);
        let cnt = le_u32(&h, 243);
        if start > 0 && cnt > 0 && start < bytes {
            f.seek(SeekFrom::Start(start))?;
            for _ in 0..cnt {
                let mut eh = [0u8; 60];
                if f.read_exact(&mut eh).is_err() {
                    break;
                }
                let len = le_u64(&eh, 20);
                if len > 512 * 1024 * 1024 {
                    break;
                }
                let mut data = vec![0u8; len as usize];
                if f.read_exact(&mut data).is_err() {
                    break;
                }
                let user = cstr(&eh[2..18]);
                let rid = le_u16(&eh, 18);
                if user == "LASF_Projection" && rid == 2112 {
                    wkt = Some(cstr(&data));
                }
                let mut raw = eh.to_vec();
                raw.extend_from_slice(&data);
                evlrs.push(json!({"userId": user, "recordId": rid, "description": cstr(&eh[22..54]), "length": len, "b64": b64(&raw)}));
            }
        }
    }
    if wkt.is_some() || gk.is_some() {
        let mut c = serde_json::Map::new();
        if let Some(w) = &wkt {
            c.insert("wkt".into(), json!(w));
            if let Some(code) = epsg_from_wkt(w) {
                c.insert("epsg".into(), json!(code));
            }
        }
        if let Some(g) = &gk {
            c.insert("geokeys".into(), g.clone());
            if !c.contains_key("epsg") {
                if let Some(p) = g.get("projected").or(g.get("geographic")) {
                    if p.as_u64().unwrap_or(0) > 0 && p.as_u64().unwrap() != 32767 {
                        c.insert("epsg".into(), p.clone());
                    }
                }
            }
        }
        crs = Some(Value::Object(c));
    }
    let has_gps = matches!(pf, 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10);
    let has_rgb = matches!(pf, 2 | 3 | 5 | 7 | 8 | 10);
    let date = format!("{}-{:03}", le_u16(&h, 92), le_u16(&h, 90));
    let meta = json!({
        "format": if pf_raw & 0xc0 != 0 { "LAZ" } else { "LAS" },
        "version": format!("{}.{}", vmaj, vmin),
        "pointFormat": pf,
        "recordLength": rec_len,
        "extraBytes": (rec_len as i32 - std_len(pf) as i32).max(0),
        "points": n,
        "scale": scale, "offset": offset,
        "bounds": {"min": [minx, miny, minz], "max": [maxx, maxy, maxz]},
        "systemIdentifier": cstr(&h[26..58]),
        "generatingSoftware": cstr(&h[58..90]),
        "creationDate": date,
        "globalEncoding": le_u16(&h, 6),
        "fileSourceId": le_u16(&h, 4),
        "header": b64(&hdr),
        "vlrs": vlrs, "evlrs": evlrs,
    });
    let bad = !(minx.is_finite() && maxx.is_finite() && maxx >= minx && maxy >= miny && maxz >= minz) || (minx == 0.0 && maxx == 0.0 && n > 1);
    Ok(Source {
        path: path.to_path_buf(),
        kind: Kind::Las,
        scan: 0,
        label: path.file_name().unwrap().to_string_lossy().to_string(),
        points: n,
        bytes,
        bounds: if bad { None } else { Some([minx, miny, minz, maxx, maxy, maxz]) },
        scale: Some(scale),
        offset: Some(offset),
        has: Has { intensity: true, rgb: has_rgb, gps: has_gps, las: true },
        meta,
        crs,
        pose: None,
    })
}

pub fn std_len(pf: u8) -> u16 {
    match pf {
        0 => 20,
        1 => 28,
        2 => 26,
        3 => 34,
        4 => 57,
        5 => 63,
        6 => 30,
        7 => 36,
        8 => 38,
        9 => 59,
        10 => 67,
        _ => 0,
    }
}

pub fn epsg_from_wkt(w: &str) -> Option<u64> {
    // the last AUTHORITY["EPSG","nnnn"] / ID["EPSG",nnnn] in the top-level object is the CRS code
    let mut best = None;
    for pat in ["AUTHORITY[\"EPSG\",\"", "ID[\"EPSG\","] {
        if let Some(i) = w.rfind(pat) {
            let rest = &w[i + pat.len()..];
            let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(v) = digits.parse::<u64>() {
                best = Some((i, v));
            }
        }
    }
    best.map(|b| b.1)
}

fn qrot(q: [f64; 4], p: [f64; 3]) -> [f64; 3] {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
    let n = (w * w + x * x + y * y + z * z).sqrt().max(1e-12);
    let (w, x, y, z) = (w / n, x / n, y / n, z / n);
    let m = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ];
    [m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2], m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2], m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2]]
}

fn read_e57_meta(path: &Path) -> Result<(Vec<Source>, Value)> {
    let r = e57::E57Reader::from_file(path).map_err(|e| anyhow!("{}: {}", path.display(), e))?;
    let bytes = std::fs::metadata(path)?.len();
    let pcs = r.pointclouds();
    let fname = path.file_name().unwrap().to_string_lossy().to_string();
    let xml = r.xml();
    let file_meta = json!({
        "format": "E57",
        "guid": r.guid(),
        "formatName": r.format_name(),
        "libraryVersion": r.library_version(),
        "coordinateMetadata": r.coordinate_metadata(),
        "creation": r.creation().map(|d| d.gps_time),
        "scans": pcs.len(),
        "images": r.images().len(),
        "xml": if xml.len() < 4 * 1024 * 1024 { Some(b64(xml.as_bytes())) } else { None },
    });
    let crs = r.coordinate_metadata().filter(|s| !s.trim().is_empty()).map(|s| {
        let mut c = json!({"wkt": s});
        if let Some(code) = epsg_from_wkt(s) {
            c["epsg"] = json!(code);
        }
        c
    });
    let mut out = vec![];
    for (i, pc) in pcs.iter().enumerate() {
        let pose = pc.transform.as_ref().map(|t| ([t.rotation.w, t.rotation.x, t.rotation.y, t.rotation.z], [t.translation.x, t.translation.y, t.translation.z]));
        // bounds in world: the scan's local bounds pushed through its pose
        let mut bounds = None;
        if let Some(b) = pc.get_cartesian_bounds() {
            if let (Some(a), Some(bx), Some(c), Some(d), Some(e), Some(g)) = (b.x_min, b.x_max, b.y_min, b.y_max, b.z_min, b.z_max) {
                let mut mn = [f64::MAX; 3];
                let mut mx = [f64::MIN; 3];
                for k in 0..8 {
                    let p = [if k & 1 == 0 { a } else { bx }, if k & 2 == 0 { c } else { d }, if k & 4 == 0 { e } else { g }];
                    let w = match pose {
                        Some((q, t)) => {
                            let r = qrot(q, p);
                            [r[0] + t[0], r[1] + t[1], r[2] + t[2]]
                        }
                        None => p,
                    };
                    for j in 0..3 {
                        mn[j] = mn[j].min(w[j]);
                        mx[j] = mx[j].max(w[j]);
                    }
                }
                bounds = Some([mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]]);
            }
        }
        if bounds.is_none() {
            if let Some(sb) = &pc.spherical_bounds {
                if let Some(rm) = sb.range_max {
                    let t = pose.map(|p| p.1).unwrap_or([0.0; 3]);
                    bounds = Some([t[0] - rm, t[1] - rm, t[2] - rm, t[0] + rm, t[1] + rm, t[2] + rm]);
                }
            }
        }
        let meta = json!({
            "format": "E57",
            "scanIndex": i,
            "name": pc.name, "description": pc.description, "guid": pc.guid,
            "records": pc.records,
            "pose": pose.map(|(q, t)| json!({"rotation": {"w": q[0], "x": q[1], "y": q[2], "z": q[3]}, "translation": t})),
            "sensor": {"vendor": pc.sensor_vendor, "model": pc.sensor_model, "serial": pc.sensor_serial, "hardware": pc.sensor_hw_version, "software": pc.sensor_sw_version, "firmware": pc.sensor_fw_version},
            "acquisitionStart": pc.acquisition_start.as_ref().map(|d| d.gps_time),
            "acquisitionEnd": pc.acquisition_end.as_ref().map(|d| d.gps_time),
            "hasColor": pc.has_color(), "hasIntensity": pc.has_intensity(), "hasCartesian": pc.has_cartesian(), "hasSpherical": pc.has_spherical(), "hasRowColumn": pc.has_row_column(),
            "intensityLimits": pc.intensity_limits.as_ref().map(|l| format!("{:?}", l)),
            "colorLimits": pc.color_limits.as_ref().map(|l| format!("{:?}", l)),
        });
        let label = match &pc.name {
            Some(n) if !n.is_empty() => format!("{} · {}", fname, n),
            _ => format!("{} · scan {}", fname, i + 1),
        };
        out.push(Source {
            path: path.to_path_buf(),
            kind: Kind::E57,
            scan: i,
            label,
            points: pc.records,
            bytes: if pcs.len() > 0 { bytes / pcs.len() as u64 } else { bytes },
            bounds,
            scale: None,
            offset: None,
            has: Has { intensity: pc.has_intensity(), rgb: pc.has_color(), gps: false, las: false },
            meta,
            crs: crs.clone(),
            pose,
        });
    }
    Ok((out, file_meta))
}

/// Reads every input's metadata. Returns the sources (one per LAS/LAZ file, one per E57 scan)
/// and file-level E57 metadata keyed by path.
pub fn read_sources(files: &[PathBuf]) -> Result<(Vec<Source>, Vec<(String, Value)>)> {
    let mut srcs = vec![];
    let mut files_meta = vec![];
    for p in files {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext == "e57" {
            let (s, fm) = read_e57_meta(p)?;
            files_meta.push((p.file_name().unwrap().to_string_lossy().to_string(), fm));
            srcs.extend(s);
        } else {
            srcs.push(read_las_meta(p)?);
        }
    }
    if srcs.len() > 65535 {
        bail!("{} sources (files and E57 scans). The limit is 65,535; merge some tiles first.", srcs.len());
    }
    Ok((srcs, files_meta))
}

/// Splits sources into units of at most `max_pts` points so threads share the work.
/// E57 scans are read whole (the format cannot seek inside a scan cheaply).
pub fn make_units(srcs: &[Source], max_pts: u64) -> Vec<Unit> {
    let mut u = vec![];
    for (i, s) in srcs.iter().enumerate() {
        if s.kind == Kind::Las && s.points > max_pts {
            let mut st = 0;
            while st < s.points {
                let c = max_pts.min(s.points - st);
                u.push(Unit { src: i, start: st, count: c });
                st += c;
            }
        } else {
            u.push(Unit { src: i, start: 0, count: s.points });
        }
    }
    // biggest first, so the tail of the run is short pieces
    u.sort_by(|a, b| b.count.cmp(&a.count));
    u
}

/// How a source's integer coordinates map onto the dataset grid.
struct Mapper {
    exact: Option<[i64; 3]>,
    s: [f64; 3],
    o: [f64; 3],
    g: Grid,
}
impl Mapper {
    fn new(src: &Source, g: Grid) -> Mapper {
        let (s, o) = (src.scale.unwrap_or([1.0; 3]), src.offset.unwrap_or([0.0; 3]));
        let mut exact = Some([0i64; 3]);
        for k in 0..3 {
            let d = (o[k] - g.offset[k]) / g.scale[k];
            if (s[k] - g.scale[k]).abs() > 1e-12 * g.scale[k].max(1e-12) || (d - d.round()).abs() > 1e-6 {
                exact = None;
                break;
            }
            exact.as_mut().unwrap()[k] = d.round() as i64;
        }
        Mapper { exact, s, o, g }
    }
    #[inline]
    fn las(&self, xi: i32, k: usize) -> i64 {
        match self.exact {
            Some(d) => xi as i64 + d[k],
            None => ((xi as f64 * self.s[k] + self.o[k] - self.g.offset[k]) / self.g.scale[k]).round() as i64,
        }
    }
}

#[inline]
pub fn quant(g: &Grid, w: f64, k: usize) -> i64 {
    ((w - g.offset[k]) / g.scale[k]).round() as i64
}

/// Streams a unit's points, in batches, as Recs on the grid. Points whose integer position falls
/// outside 0..i32::MAX are reported through `outside` (the caller re-plans the grid).
/// Returns the number of invalid points skipped (E57 points without a valid position).
pub fn read_unit(srcs: &[Source], unit: &Unit, g: Grid, batch: usize, mut cb: impl FnMut(&[Rec]) -> Result<()>, outside: &mut u64) -> Result<u64> {
    let src = &srcs[unit.src];
    let sid = unit.src as u16;
    let mut buf: Vec<Rec> = Vec::with_capacity(batch);
    let mut skipped = 0u64;
    let fit = |v: i64, outside: &mut u64| -> i32 {
        if v < 0 || v > i32::MAX as i64 {
            *outside += 1;
            v.clamp(0, i32::MAX as i64) as i32
        } else {
            v as i32
        }
    };
    match src.kind {
        Kind::Las => {
            let mut rd = las::Reader::from_path(&src.path).with_context(|| format!("reading {}", src.path.display()))?;
            if unit.start > 0 {
                rd.seek(unit.start).with_context(|| format!("seeking in {}", src.path.display()))?;
            }
            let pf = src.meta["pointFormat"].as_u64().unwrap_or(0) as u8;
            let m = Mapper::new(src, g);
            let mut pd = las::PointDataBuilder::new().for_header(rd.header()).build();
            let mut left = unit.count;
            while left > 0 {
                let want = left.min(batch as u64);
                let got = rd.fill_points(want, &mut pd).with_context(|| format!("decoding {}", src.path.display()))?;
                if got == 0 {
                    bail!("{} ended early ({} points short of its header count)", src.path.display(), left);
                }
                let rl = pd.record_len();
                let raw = pd.raw_bytes();
                buf.clear();
                for i in 0..got as usize {
                    let r = &raw[i * rl..i * rl + rl];
                    let xi = i32::from_le_bytes(r[0..4].try_into().unwrap());
                    let yi = i32::from_le_bytes(r[4..8].try_into().unwrap());
                    let zi = i32::from_le_bytes(r[8..12].try_into().unwrap());
                    let mut p = Rec { x: fit(m.las(xi, 0), outside), y: fit(m.las(yi, 1), outside), z: fit(m.las(zi, 2), outside), intensity: u16::from_le_bytes([r[12], r[13]]), src: sid, ..Default::default() };
                    if pf < 6 {
                        p.ret = r[14] & 7;
                        p.nret = (r[14] >> 3) & 7;
                        p.flags = ((r[14] >> 6) & 1) << 4 | ((r[14] >> 7) & 1) << 5 | ((r[15] >> 5) & 7);
                        p.cls = r[15] & 31;
                        p.scan_angle = ((r[16] as i8) as f64 / 0.006).round() as i16;
                        p.user = r[17];
                        p.psid = u16::from_le_bytes([r[18], r[19]]);
                        let mut o = 20;
                        if matches!(pf, 1 | 3 | 4 | 5) {
                            p.gps = f64::from_le_bytes(r[20..28].try_into().unwrap());
                            o = 28;
                        }
                        if matches!(pf, 2 | 3 | 5) {
                            p.r = u16::from_le_bytes([r[o], r[o + 1]]);
                            p.g = u16::from_le_bytes([r[o + 2], r[o + 3]]);
                            p.b = u16::from_le_bytes([r[o + 4], r[o + 5]]);
                        }
                    } else {
                        p.ret = r[14] & 15;
                        p.nret = r[14] >> 4;
                        p.flags = (r[15] & 15) | ((r[15] >> 6) & 1) << 4 | ((r[15] >> 7) & 1) << 5;
                        p.chan = (r[15] >> 4) & 3;
                        p.cls = r[16];
                        p.user = r[17];
                        p.scan_angle = i16::from_le_bytes([r[18], r[19]]);
                        p.psid = u16::from_le_bytes([r[20], r[21]]);
                        p.gps = f64::from_le_bytes(r[22..30].try_into().unwrap());
                        if matches!(pf, 7 | 8 | 10) {
                            p.r = u16::from_le_bytes([r[30], r[31]]);
                            p.g = u16::from_le_bytes([r[32], r[33]]);
                            p.b = u16::from_le_bytes([r[34], r[35]]);
                        }
                    }
                    buf.push(p);
                }
                cb(&buf)?;
                left -= got;
            }
        }
        Kind::E57 => {
            let mut r = e57::E57Reader::from_file(&src.path).map_err(|e| anyhow!("{}: {}", src.path.display(), e))?;
            let pcs = r.pointclouds();
            let pc = pcs.get(src.scan).ok_or_else(|| anyhow!("scan {} missing in {}", src.scan, src.path.display()))?;
            let mut it = r.pointcloud_simple(pc).map_err(|e| anyhow!("{}: {}", src.path.display(), e))?;
            it.apply_pose(true);
            it.spherical_to_cartesian(true);
            it.normalize_intensity(true);
            it.normalize_color(true);
            for pt in it {
                let pt = pt.map_err(|e| anyhow!("{}: {}", src.path.display(), e))?;
                let (x, y, z) = match pt.cartesian {
                    e57::CartesianCoordinate::Valid { x, y, z } => (x, y, z),
                    _ => {
                        skipped += 1;
                        continue;
                    }
                };
                let mut p = Rec { x: fit(quant(&g, x, 0), outside), y: fit(quant(&g, y, 1), outside), z: fit(quant(&g, z, 2), outside), src: sid, ret: 1, nret: 1, ..Default::default() };
                if let Some(i) = pt.intensity {
                    p.intensity = (i.clamp(0.0, 1.0) * 65535.0).round() as u16;
                }
                if let Some(c) = pt.color {
                    p.r = (c.red.clamp(0.0, 1.0) * 65535.0).round() as u16;
                    p.g = (c.green.clamp(0.0, 1.0) * 65535.0).round() as u16;
                    p.b = (c.blue.clamp(0.0, 1.0) * 65535.0).round() as u16;
                }
                buf.push(p);
                if buf.len() >= batch {
                    cb(&buf)?;
                    buf.clear();
                }
            }
            if !buf.is_empty() {
                cb(&buf)?;
            }
        }
    }
    Ok(skipped)
}

/// World-space bounds by reading every point (used when a source's header has no usable bounds).
pub fn scan_bounds(srcs: &[Source], unit: &Unit) -> Result<[f64; 6]> {
    // read on a fine grid anchored at 0 with 0.1 mm steps in i64 space, without clamping
    let src = &srcs[unit.src];
    let mut b = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    match src.kind {
        Kind::Las => {
            let mut rd = las::Reader::from_path(&src.path)?;
            if unit.start > 0 {
                rd.seek(unit.start)?;
            }
            let (s, o) = (src.scale.unwrap(), src.offset.unwrap());
            let mut pd = las::PointDataBuilder::new().for_header(rd.header()).build();
            let mut left = unit.count;
            while left > 0 {
                let got = rd.fill_points(left.min(1 << 20), &mut pd)?;
                if got == 0 {
                    break;
                }
                let rl = pd.record_len();
                let raw = pd.raw_bytes();
                for i in 0..got as usize {
                    let r = &raw[i * rl..];
                    for k in 0..3 {
                        let v = i32::from_le_bytes(r[k * 4..k * 4 + 4].try_into().unwrap()) as f64 * s[k] + o[k];
                        b[k] = b[k].min(v);
                        b[k + 3] = b[k + 3].max(v);
                    }
                }
                left -= got;
            }
        }
        Kind::E57 => {
            let mut r = e57::E57Reader::from_file(&src.path).map_err(|e| anyhow!("{}", e))?;
            let pcs = r.pointclouds();
            let mut it = r.pointcloud_simple(&pcs[src.scan]).map_err(|e| anyhow!("{}", e))?;
            it.apply_pose(true);
            it.spherical_to_cartesian(true);
            for pt in it {
                if let e57::CartesianCoordinate::Valid { x, y, z } = pt.map_err(|e| anyhow!("{}", e))?.cartesian {
                    for (k, v) in [x, y, z].into_iter().enumerate() {
                        b[k] = b[k].min(v);
                        b[k + 3] = b[k + 3].max(v);
                    }
                }
            }
        }
    }
    Ok(b)
}
