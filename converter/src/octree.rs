//! Octree nodes: sampling, columnar encoding and the paged hierarchy file.
use crate::rec::Rec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;

/// Which attribute columns are written (decided from what the sources actually contain).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Attrs {
    pub intensity: bool,
    pub rgb: bool,
    pub classification: bool,
    pub returns: bool,
    pub flags: bool,
    pub channel: bool,
    pub user_data: bool,
    pub scan_angle: bool,
    pub point_source_id: bool,
    pub gps_time: bool,
    pub source: bool,
}

impl Attrs {
    /// The attribute list for dataset.json, in blob order. Every attribute is stored as
    /// `components` consecutive columns of `type` (component-major).
    pub fn describe(&self) -> Value {
        let mut a = vec![json!({"name": "position", "type": "uint32", "components": 3, "note": "integer offset from the node's minimum corner; world = offset + (nodeMin + value) * scale"})];
        let mut add = |on: bool, name: &str, ty: &str, c: u32| {
            if on {
                a.push(json!({"name": name, "type": ty, "components": c}));
            }
        };
        add(self.intensity, "intensity", "uint16", 1);
        add(self.rgb, "rgb", "uint16", 3);
        add(self.classification, "classification", "uint8", 1);
        add(self.returns, "return_number", "uint8", 1);
        add(self.returns, "number_of_returns", "uint8", 1);
        add(self.flags, "flags", "uint8", 1);
        add(self.channel, "scanner_channel", "uint8", 1);
        add(self.user_data, "user_data", "uint8", 1);
        add(self.scan_angle, "scan_angle", "int16", 1);
        add(self.point_source_id, "point_source_id", "uint16", 1);
        add(self.gps_time, "gps_time", "float64", 1);
        add(self.source, "source", "uint16", 1);
        Value::Array(a)
    }
    pub fn bytes_per_point(&self) -> usize {
        12 + 2 * self.intensity as usize + 6 * self.rgb as usize + self.classification as usize + 2 * self.returns as usize + self.flags as usize + self.channel as usize + self.user_data as usize + 2 * self.scan_angle as usize + 2 * self.point_source_id as usize + 8 * self.gps_time as usize + 2 * self.source as usize
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeRec {
    pub name: String,
    pub count: u32,
    pub off: u64,
    pub size: u64,
}

#[inline]
fn spread21(v: u64) -> u64 {
    let mut x = v & 0x1f_ffff;
    x = (x | x << 32) & 0x1f00000000ffff;
    x = (x | x << 16) & 0x1f0000ff0000ff;
    x = (x | x << 8) & 0x100f00f00f00f00f;
    x = (x | x << 4) & 0x10c30c30c30c30c3;
    x = (x | x << 2) & 0x1249249249249249;
    x
}

/// Columnar encoding of one node. Points are sorted along a Morton curve first, which keeps
/// neighbours together and makes every column compress better.
pub fn encode(recs: &mut [Rec], min: [i64; 3], units: u64, a: &Attrs, level: u32) -> Vec<u8> {
    let bits = 63 - units.max(1).leading_zeros(); // log2(units)
    let sh = bits.saturating_sub(21);
    if recs.len() > 1 {
        recs.sort_unstable_by_key(|r| {
            let x = ((r.x as i64 - min[0]) as u64) >> sh;
            let y = ((r.y as i64 - min[1]) as u64) >> sh;
            let z = ((r.z as i64 - min[2]) as u64) >> sh;
            spread21(x) | spread21(y) << 1 | spread21(z) << 2
        });
    }
    let n = recs.len();
    let mut out = Vec::with_capacity(n * a.bytes_per_point());
    for k in 0..3 {
        for r in recs.iter() {
            let v = [r.x, r.y, r.z][k] as i64 - min[k];
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
    }
    macro_rules! col {
        ($on:expr, $f:expr) => {
            if $on {
                for r in recs.iter() {
                    out.extend_from_slice(&($f)(r).to_le_bytes());
                }
            }
        };
    }
    col!(a.intensity, |r: &Rec| r.intensity);
    col!(a.rgb, |r: &Rec| r.r);
    col!(a.rgb, |r: &Rec| r.g);
    col!(a.rgb, |r: &Rec| r.b);
    col!(a.classification, |r: &Rec| r.cls);
    col!(a.returns, |r: &Rec| r.ret);
    col!(a.returns, |r: &Rec| r.nret);
    col!(a.flags, |r: &Rec| r.flags);
    col!(a.channel, |r: &Rec| r.chan);
    col!(a.user_data, |r: &Rec| r.user);
    col!(a.scan_angle, |r: &Rec| r.scan_angle);
    col!(a.point_source_id, |r: &Rec| r.psid);
    col!(a.gps_time, |r: &Rec| r.gps);
    col!(a.source, |r: &Rec| r.src);
    let _ = level;
    out
}

pub fn compress(raw: Vec<u8>, level: u32) -> Vec<u8> {
    if level == 0 || raw.is_empty() {
        return raw;
    }
    let mut e = flate2::write::GzEncoder::new(Vec::with_capacity(raw.len() / 2), flate2::Compression::new(level.min(9)));
    e.write_all(&raw).unwrap();
    e.finish().unwrap()
}

/// Decodes a node back into Recs (used by export and verify).
pub fn decode(blob: &[u8], gz: bool, n: usize, min: [i64; 3], a: &Attrs) -> anyhow::Result<Vec<Rec>> {
    let raw;
    let b: &[u8] = if gz && !blob.is_empty() {
        let mut d = flate2::read::GzDecoder::new(blob);
        let mut v = Vec::with_capacity(n * a.bytes_per_point());
        std::io::Read::read_to_end(&mut d, &mut v)?;
        raw = v;
        &raw
    } else {
        blob
    };
    if b.len() != n * a.bytes_per_point() {
        anyhow::bail!("node holds {} bytes, expected {}", b.len(), n * a.bytes_per_point());
    }
    let mut v = vec![Rec::default(); n];
    let mut p = 0usize;
    for k in 0..3 {
        for r in v.iter_mut() {
            let x = u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) as i64 + min[k];
            match k {
                0 => r.x = x as i32,
                1 => r.y = x as i32,
                _ => r.z = x as i32,
            }
            p += 4;
        }
    }
    macro_rules! rd {
        ($on:expr, $t:ty, $set:expr) => {
            if $on {
                const S: usize = std::mem::size_of::<$t>();
                for r in v.iter_mut() {
                    let x = <$t>::from_le_bytes(b[p..p + S].try_into().unwrap());
                    ($set)(r, x);
                    p += S;
                }
            }
        };
    }
    rd!(a.intensity, u16, |r: &mut Rec, x| r.intensity = x);
    rd!(a.rgb, u16, |r: &mut Rec, x| r.r = x);
    rd!(a.rgb, u16, |r: &mut Rec, x| r.g = x);
    rd!(a.rgb, u16, |r: &mut Rec, x| r.b = x);
    rd!(a.classification, u8, |r: &mut Rec, x| r.cls = x);
    rd!(a.returns, u8, |r: &mut Rec, x| r.ret = x);
    rd!(a.returns, u8, |r: &mut Rec, x| r.nret = x);
    rd!(a.flags, u8, |r: &mut Rec, x| r.flags = x);
    rd!(a.channel, u8, |r: &mut Rec, x| r.chan = x);
    rd!(a.user_data, u8, |r: &mut Rec, x| r.user = x);
    rd!(a.scan_angle, i16, |r: &mut Rec, x| r.scan_angle = x);
    rd!(a.point_source_id, u16, |r: &mut Rec, x| r.psid = x);
    rd!(a.gps_time, f64, |r: &mut Rec, x| r.gps = x);
    rd!(a.source, u16, |r: &mut Rec, x| r.src = x);
    Ok(v)
}

/// Node cube from its name: "r" then one digit per level, digit = x | y<<1 | z<<2.
pub fn node_cube(name: &str, cube_units: u64) -> ([i64; 3], u64) {
    let mut min = [0i64; 3];
    let mut s = cube_units;
    for c in name.bytes().skip(1) {
        s /= 2;
        let d = (c - b'0') as i64;
        min[0] += (d & 1) * s as i64;
        min[1] += ((d >> 1) & 1) * s as i64;
        min[2] += ((d >> 2) & 1) * s as i64;
    }
    (min, s)
}

/// Grid sampling: the first point (in the given, shuffled order) in each of G³ cells is kept
/// for this node; the rest move on to the children.
pub fn sample(recs: Vec<Rec>, min: [i64; 3], units: u64, g: u64, bits: &mut Vec<u64>) -> (Vec<Rec>, Vec<Rec>) {
    let gl = 63 - g.leading_zeros();
    let ul = 63 - units.max(1).leading_zeros();
    let (sh, gg) = if ul >= gl { (ul - gl, g) } else { (0, units.max(1)) };
    let cells = (gg * gg * gg) as usize;
    bits.clear();
    bits.resize(cells.div_ceil(64), 0);
    let mut acc = Vec::with_capacity((recs.len() / 4).min(1 << 20));
    let mut rest = Vec::with_capacity(recs.len());
    for r in recs {
        let cx = (((r.x as i64 - min[0]) as u64) >> sh).min(gg - 1);
        let cy = (((r.y as i64 - min[1]) as u64) >> sh).min(gg - 1);
        let cz = (((r.z as i64 - min[2]) as u64) >> sh).min(gg - 1);
        let c = ((cx * gg + cy) * gg + cz) as usize;
        let (w, b) = (c >> 6, 1u64 << (c & 63));
        if bits[w] & b == 0 {
            bits[w] |= b;
            acc.push(r);
        } else {
            rest.push(r);
        }
    }
    (acc, rest)
}

/// Splits points among the 8 children of a node.
pub fn split8(recs: Vec<Rec>, min: [i64; 3], units: u64) -> [Vec<Rec>; 8] {
    let h = (units / 2) as i64;
    let mut out: [Vec<Rec>; 8] = Default::default();
    for r in recs {
        let d = ((r.x as i64 - min[0] >= h) as usize) | ((r.y as i64 - min[1] >= h) as usize) << 1 | ((r.z as i64 - min[2] >= h) as usize) << 2;
        out[d].push(r);
    }
    out
}

pub const ENTRY: usize = 22;

/// Paged hierarchy (as in Potree 2): each page lists the nodes of a subtree `step` levels deep in
/// breadth-first order; nodes on the page's last level that have children are proxies pointing at
/// the page that starts with them. Entry (22 bytes, little-endian):
/// type u8 (0 inner, 1 leaf, 2 proxy) · child mask u8 · points u32 · offset u64 · size u64.
/// For inner and leaf nodes offset/size locate the node in octree.bin; for proxies they locate
/// the next page in hierarchy.bin.
pub fn build_hierarchy(nodes: &HashMap<String, NodeRec>, step: usize) -> (Vec<u8>, u64, usize) {
    let mask = |n: &str| -> u8 {
        let mut m = 0u8;
        for d in 0..8u8 {
            let mut c = String::with_capacity(n.len() + 1);
            c.push_str(n);
            c.push((b'0' + d) as char);
            if nodes.contains_key(&c) {
                m |= 1 << d;
            }
        }
        m
    };
    let mut pages: Vec<(String, Vec<(String, bool)>)> = vec![];
    let mut roots = vec!["r".to_string()];
    let mut i = 0;
    while i < roots.len() {
        let r = roots[i].clone();
        let lim = r.len() - 1 + step;
        let mut list = vec![];
        let mut q = std::collections::VecDeque::from([r.clone()]);
        while let Some(n) = q.pop_front() {
            let lvl = n.len() - 1;
            let m = mask(&n);
            let proxy = lvl == lim && m != 0 && n != r;
            list.push((n.clone(), proxy));
            if proxy {
                roots.push(n.clone());
                continue;
            }
            for d in 0..8u8 {
                if m & (1 << d) != 0 {
                    q.push_back(format!("{}{}", n, d));
                }
            }
        }
        pages.push((r, list));
        i += 1;
    }
    let mut at = HashMap::new();
    let mut off = 0u64;
    for (r, l) in &pages {
        let sz = (l.len() * ENTRY) as u64;
        at.insert(r.clone(), (off, sz));
        off += sz;
    }
    let mut out = Vec::with_capacity(off as usize);
    let mut depth = 0;
    for (_, l) in &pages {
        for (n, proxy) in l {
            let nr = &nodes[n];
            let m = mask(n);
            depth = depth.max(n.len() - 1);
            let (t, o, s) = if *proxy {
                let (o, s) = at[n];
                (2u8, o, s)
            } else {
                (if m != 0 { 0u8 } else { 1u8 }, nr.off, nr.size)
            };
            out.push(t);
            out.push(m);
            out.extend_from_slice(&nr.count.to_le_bytes());
            out.extend_from_slice(&o.to_le_bytes());
            out.extend_from_slice(&s.to_le_bytes());
        }
    }
    let first = at["r"].1;
    (out, first, depth)
}

/// Reads the whole hierarchy back (export, verify, info).
pub fn read_hierarchy(h: &[u8], first: u64) -> anyhow::Result<Vec<NodeRec>> {
    let mut out = vec![];
    let mut pages = vec![("r".to_string(), 0u64, first)];
    while let Some((root, off, size)) = pages.pop() {
        let b = h.get(off as usize..(off + size) as usize).ok_or_else(|| anyhow::anyhow!("hierarchy page out of range"))?;
        let mut q = std::collections::VecDeque::from([root.clone()]);
        let mut k = 0;
        while let Some(n) = q.pop_front() {
            let e = &b[k * ENTRY..k * ENTRY + ENTRY];
            k += 1;
            let (t, m) = (e[0], e[1]);
            let cnt = u32::from_le_bytes(e[2..6].try_into().unwrap());
            let o = u64::from_le_bytes(e[6..14].try_into().unwrap());
            let s = u64::from_le_bytes(e[14..22].try_into().unwrap());
            if t == 2 && n != root {
                pages.push((n, o, s));
                continue;
            }
            out.push(NodeRec { name: n.clone(), count: cnt, off: o, size: s });
            for d in 0..8u8 {
                if m & (1 << d) != 0 {
                    q.push_back(format!("{}{}", n, d));
                }
            }
        }
    }
    Ok(out)
}
