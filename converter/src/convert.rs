//! The conversion pipeline.
//!
//! 1. Read every source's metadata (headers, VLRs, E57 scans and poses).
//! 2. Plan: dataset grid (offset/scale), octree cube, memory/threads, chunk and node sizes.
//! 3. Count pass: points per cell of a coarse grid (plus attribute usage and checksums).
//! 4. Chunking: split the cube into octree cells that each fit in memory.
//! 5. Distribute pass: every point is appended to its chunk's temporary file.
//! 6. Index: each chunk becomes an octree subtree (grid sampling, top-down), written to octree.bin.
//! 7. Upper levels: chunk roots are merged upwards to the root.
//! 8. Paged hierarchy, dataset.json and project.json.
//! Steps 6-8 are journaled; `--resume` continues an interrupted run from the last finished chunk.
use crate::input::{self, Grid, Source, Unit};
use crate::octree::{self, Attrs, NodeRec};
use crate::rec::{self, Rec};
use anyhow::{bail, Context, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

pub struct Opts {
    pub inputs: Vec<PathBuf>,
    pub out: PathBuf,
    pub name: Option<String>,
    pub threads: Option<usize>,
    pub memory_gb: Option<f64>,
    pub preset: String,
    pub scale: Option<f64>,
    pub node_points: Option<u64>,
    pub sample_grid: Option<u64>,
    pub chunk_points: Option<u64>,
    pub count_grid: Option<u64>,
    pub compression: u32,
    pub step: usize,
    pub temp: Option<PathBuf>,
    pub resume: bool,
    pub overwrite: bool,
    pub keep_temp: bool,
    pub force: bool,
    pub crs: Option<String>,
    pub drop: Vec<String>,
    pub dry_run: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Chunk {
    pub name: String,
    pub count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub offset: [f64; 3],
    pub scale: [f64; 3],
    pub cube_units: u64,
    pub count_grid: u64,
    pub chunk_points: u64,
    pub node_points: u64,
    pub sample_grid: u64,
    pub threads: usize,
    pub memory_bytes: u64,
    pub compression: u32,
    pub step: usize,
    pub attrs: Attrs,
    pub chunks: Vec<Chunk>,
    pub total: u64,
    pub skipped: u64,
    pub tight: [i64; 6],
    pub checks: Vec<SrcCheck>,
    pub inputs: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SrcCheck {
    pub points: u64,
    pub full: u64,
    pub position: u64,
}

#[inline]
pub fn rec_hash(r: &Rec) -> (u64, u64) {
    let p = (r.x as u32 as u64).wrapping_mul(0x9E3779B97F4A7C15) ^ (r.y as u32 as u64).wrapping_mul(0xC2B2AE3D27D4EB4F).rotate_left(21) ^ (r.z as u32 as u64).wrapping_mul(0x165667B19E3779F9).rotate_left(42);
    let a = (r.intensity as u64) | (r.r as u64) << 16 | (r.g as u64) << 32 | (r.b as u64) << 48;
    let b = (r.cls as u64) | (r.ret as u64) << 8 | (r.nret as u64) << 16 | (r.flags as u64) << 24 | (r.chan as u64) << 32 | (r.user as u64) << 40 | (r.psid as u64) << 48;
    let f = p ^ a.wrapping_mul(0xD6E8FEB86659FD93) ^ b.wrapping_mul(0xA0761D6478BD642F).rotate_left(17) ^ r.gps.to_bits().wrapping_mul(0xE7037ED1A0B428DB).rotate_left(29) ^ (r.scan_angle as u16 as u64).wrapping_mul(0x8EBC6AF09C88C6E3);
    (f, p)
}

// ---------- progress ----------
pub struct Prog {
    pub stage: Mutex<String>,
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub t0: Mutex<Instant>,
    pub run: AtomicBool,
    pub start: Instant,
    pub log: Mutex<Option<File>>,
    pub status: PathBuf,
}
impl Prog {
    pub fn stage(&self, s: &str, total: u64) {
        *self.stage.lock().unwrap() = s.to_string();
        self.total.store(total, Ordering::SeqCst);
        self.done.store(0, Ordering::SeqCst);
        *self.t0.lock().unwrap() = Instant::now();
        self.say(&format!("{}…", s));
    }
    pub fn say(&self, s: &str) {
        let line = format!("[{:>7}] {}", fmt_dur(self.start.elapsed().as_secs_f64()), s);
        eprintln!("{}", line);
        if let Some(f) = self.log.lock().unwrap().as_mut() {
            let _ = writeln!(f, "{}", line);
        }
    }
    fn tick(&self) {
        let (d, t) = (self.done.load(Ordering::Relaxed), self.total.load(Ordering::Relaxed));
        if t == 0 {
            return;
        }
        let el = self.t0.lock().unwrap().elapsed().as_secs_f64();
        let rate = d as f64 / el.max(1e-3);
        let eta = if d > 0 { (t - d.min(t)) as f64 / rate } else { 0.0 };
        let st = self.stage.lock().unwrap().clone();
        eprintln!("          {} {:>5.1}%  {} of {} points  {}/s  about {} left", st, d as f64 * 100.0 / t as f64, fmt_n(d), fmt_n(t), fmt_n(rate as u64), fmt_dur(eta));
        let _ = fs::write(&self.status, serde_json::to_string(&json!({"stage": st, "done": d, "total": t, "rate": rate, "eta": eta, "elapsed": self.start.elapsed().as_secs_f64()})).unwrap());
    }
}
pub fn fmt_n(n: u64) -> String {
    let f = n as f64;
    if f >= 1e9 {
        format!("{:.2} B", f / 1e9)
    } else if f >= 1e6 {
        format!("{:.1} M", f / 1e6)
    } else if f >= 1e3 {
        format!("{:.1} k", f / 1e3)
    } else {
        format!("{}", n)
    }
}
pub fn fmt_dur(s: f64) -> String {
    let s = s.max(0.0) as u64;
    if s >= 3600 {
        format!("{}h{:02}m", s / 3600, (s % 3600) / 60)
    } else if s >= 60 {
        format!("{}m{:02}s", s / 60, s % 60)
    } else {
        format!("{}s", s)
    }
}
fn fmt_b(b: u64) -> String {
    let f = b as f64;
    if f >= 1e12 {
        format!("{:.2} TB", f / 1e12)
    } else if f >= 1e9 {
        format!("{:.1} GB", f / 1e9)
    } else {
        format!("{:.0} MB", f / 1e6)
    }
}

/// Bounds concurrent chunk memory by point count.
struct MemSem {
    cap: u64,
    used: Mutex<u64>,
    cv: Condvar,
}
impl MemSem {
    fn acquire(&self, n: u64) -> u64 {
        let n = n.min(self.cap);
        let mut u = self.used.lock().unwrap();
        while *u + n > self.cap {
            u = self.cv.wait(u).unwrap();
        }
        *u += n;
        n
    }
    fn release(&self, n: u64) {
        *self.used.lock().unwrap() -= n;
        self.cv.notify_all();
    }
}

struct OctOut {
    f: File,
    pos: u64,
}
impl OctOut {
    fn write(&mut self, b: &[u8]) -> Result<(u64, u64)> {
        let o = self.pos;
        self.f.write_all(b)?;
        self.pos += b.len() as u64;
        Ok((o, b.len() as u64))
    }
}

fn shuffle(v: &mut [Rec], seed: u64) {
    let mut s = seed | 1;
    for i in (1..v.len()).rev() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let j = (s % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}
fn name_seed(n: &str) -> u64 {
    n.bytes().fold(0xcbf29ce484222325u64, |h, c| (h ^ c as u64).wrapping_mul(0x100000001b3))
}

fn chunk_name(level: u32, c: [u64; 3]) -> String {
    let mut s = String::from("r");
    for i in 1..=level {
        let sh = level - i;
        let d = ((c[0] >> sh) & 1) | ((c[1] >> sh) & 1) << 1 | ((c[2] >> sh) & 1) << 2;
        s.push((b'0' + d as u8) as char);
    }
    s
}

fn sys_memory() -> u64 {
    let mut s = sysinfo::System::new();
    s.refresh_memory();
    s.total_memory()
}

fn next_pow2(v: u64) -> u64 {
    v.max(1).next_power_of_two()
}

pub fn read_state(tmp: &Path) -> Option<(String, Plan)> {
    let s = fs::read_to_string(tmp.join("state.json")).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    Some((v["stage"].as_str()?.to_string(), serde_json::from_value(v["plan"].clone()).ok()?))
}
fn write_state(tmp: &Path, stage: &str, plan: &Plan, extra: Value) -> Result<()> {
    let p = tmp.join("state.json.tmp");
    fs::write(&p, serde_json::to_vec(&json!({"stage": stage, "plan": plan, "extra": extra}))?)?;
    fs::rename(&p, tmp.join("state.json"))?;
    Ok(())
}

pub fn run(o: Opts) -> Result<()> {
    let start = Instant::now();
    let files = input::find_inputs(&o.inputs)?;
    fs::create_dir_all(&o.out).with_context(|| format!("creating {}", o.out.display()))?;
    let out = o.out.canonicalize()?;
    let tmp = o.temp.clone().map(|t| t.join(format!("scanlod-{}", out.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()))).unwrap_or_else(|| out.join(".scanlod-tmp"));
    if out.join("dataset.json").exists() && !o.overwrite && !o.resume {
        bail!("{} already holds a dataset. Use --overwrite to replace it.", out.display());
    }
    let resuming = o.resume && tmp.join("state.json").exists();
    if !resuming && tmp.exists() {
        fs::remove_dir_all(&tmp).ok();
    }
    fs::create_dir_all(tmp.join("chunks"))?;
    fs::create_dir_all(tmp.join("up"))?;
    let prog = Arc::new(Prog {
        stage: Mutex::new(String::new()),
        done: AtomicU64::new(0),
        total: AtomicU64::new(0),
        t0: Mutex::new(Instant::now()),
        run: AtomicBool::new(true),
        start,
        log: Mutex::new(OpenOptions::new().create(true).append(true).open(out.join("scanlod.log")).ok()),
        status: out.join("progress.json"),
    });
    {
        let p = prog.clone();
        std::thread::spawn(move || {
            let mut k = 0u64;
            while p.run.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(500));
                k += 1;
                if k % 10 == 0 && p.run.load(Ordering::Relaxed) {
                    p.tick();
                }
            }
        });
    }
    let res = run_inner(&o, &files, &out, &tmp, resuming, &prog);
    prog.run.store(false, Ordering::SeqCst);
    match &res {
        Ok(()) => {
            if !o.keep_temp && !o.dry_run {
                fs::remove_dir_all(&tmp).ok();
            }
            let _ = fs::remove_file(out.join("progress.json"));
        }
        Err(e) => {
            prog.say(&format!("Stopped: {:#}", e));
            if !o.dry_run {
                prog.say(&format!("Temporary files are kept in {}. Run the same command with --resume to continue.", tmp.display()));
            }
        }
    }
    res
}

fn run_inner(o: &Opts, files: &[PathBuf], out: &Path, tmp: &Path, resuming: bool, prog: &Arc<Prog>) -> Result<()> {
    prog.say(&format!("scanlod {} · {} input file(s)", env!("CARGO_PKG_VERSION"), files.len()));
    let (srcs, files_meta) = input::read_sources(files)?;
    let hdr_total: u64 = srcs.iter().map(|s| s.points).sum();
    let in_bytes: u64 = files.iter().map(|f| fs::metadata(f).map(|m| m.len()).unwrap_or(0)).sum();
    prog.say(&format!("{} source(s), {} points in headers, {} on disk", srcs.len(), fmt_n(hdr_total), fmt_b(in_bytes)));

    let plan = if resuming {
        let (stage, plan) = read_state(tmp).context("the temporary folder has no usable state; run without --resume")?;
        if plan.inputs != files.iter().map(|f| f.display().to_string()).collect::<Vec<_>>() {
            bail!("--resume: the inputs differ from the interrupted run");
        }
        prog.say(&format!("Resuming after stage '{}'", stage));
        plan
    } else {
        let plan = plan_and_distribute(o, files, &srcs, out, tmp, prog)?;
        match plan {
            Some(p) => p,
            None => return Ok(()), // dry run
        }
    };
    let (nodes, octree_end) = index_chunks(&plan, out, tmp, resuming, prog)?;
    let mut nodes = nodes;
    let up = upper_levels(&plan, out, tmp, octree_end, prog)?;
    nodes.extend(up);
    finish(o, &plan, &srcs, &files_meta, nodes, out, tmp, prog)
}

fn plan_and_distribute(o: &Opts, files: &[PathBuf], srcs: &[Source], out: &Path, tmp: &Path, prog: &Arc<Prog>) -> Result<Option<Plan>> {
    let threads = o.threads.unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)).max(1);
    let ram = sys_memory();
    let mem = o.memory_gb.map(|g| (g * 1e9) as u64).unwrap_or((ram as f64 * 0.6) as u64).max(1_000_000_000);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    let unit_pts = 20_000_000u64;
    let units = input::make_units(srcs, unit_pts);

    // bounds (header bounds where usable, otherwise a read)
    let mut bounds = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    let need: Vec<&Unit> = units.iter().filter(|u| srcs[u.src].bounds.is_none()).collect();
    if !need.is_empty() {
        let n: u64 = need.iter().map(|u| u.count).sum();
        prog.stage("Reading bounds (some sources do not record them)", n);
        let bs: Vec<Result<[f64; 6]>> = pool.install(|| {
            need.par_iter()
                .map(|u| {
                    let b = input::scan_bounds(srcs, u);
                    prog.done.fetch_add(u.count, Ordering::Relaxed);
                    b
                })
                .collect()
        });
        for b in bs {
            let b = b?;
            for k in 0..3 {
                bounds[k] = bounds[k].min(b[k]);
                bounds[k + 3] = bounds[k + 3].max(b[k + 3]);
            }
        }
    }
    for s in srcs {
        if let Some(b) = s.bounds {
            for k in 0..3 {
                bounds[k] = bounds[k].min(b[k]);
                bounds[k + 3] = bounds[k + 3].max(b[k + 3]);
            }
        }
    }
    if !(bounds[0] <= bounds[3]) {
        bail!("No points found in the inputs.");
    }

    let mut attempt = 0;
    loop {
        attempt += 1;
        // ----- grid -----
        let las_scale = srcs.iter().filter_map(|s| s.scale).fold(f64::MAX, |m, s| m.min(s[0]).min(s[1]).min(s[2]));
        let mut sc = o.scale.unwrap_or(if las_scale < f64::MAX { las_scale.max(1e-4) } else { 1e-4 });
        let base = srcs.iter().find_map(|s| s.offset).unwrap_or([0.0; 3]);
        let (mut offset, mut cube);
        loop {
            offset = [0.0; 3];
            let mut ext = 0u64;
            for k in 0..3 {
                offset[k] = base[k] + ((bounds[k] - base[k]) / sc).floor() * sc - sc;
                ext = ext.max(((bounds[k + 3] - offset[k]) / sc).ceil() as u64 + 2);
            }
            cube = next_pow2(ext);
            if cube <= 1u64 << 31 {
                break;
            }
            sc *= 10.0;
            prog.say(&format!("The data spans too far for the requested precision; using a {} m grid instead.", sc));
        }
        let g = Grid { offset, scale: [sc; 3] };
        let total_est = srcs.iter().map(|s| s.points).sum::<u64>();
        let mut cg = o.count_grid.unwrap_or(match total_est {
            t if t <= 1_000_000_000 => 128,
            t if t <= 20_000_000_000 => 256,
            _ => {
                if mem >= 6_000_000_000 {
                    512
                } else {
                    256
                }
            }
        });
        cg = next_pow2(cg).min(cube).max(1);
        let (node_points, sample_grid) = match o.preset.as_str() {
            "fine" => (20_000, 128),
            "coarse" => (100_000, 256),
            _ => (50_000, 128),
        };
        let node_points = o.node_points.unwrap_or(node_points).max(1_000);
        let sample_grid = next_pow2(o.sample_grid.unwrap_or(sample_grid)).clamp(16, 1024);
        // sized so the chunks fit in memory together, and so there are enough of them to keep every thread busy
        let chunk_points = o.chunk_points.unwrap_or((((mem as f64 * 0.7) / (threads as f64 * 140.0)) as u64).min((total_est / (threads as u64 * 3)).max(1_000_000))).clamp(1_000_000, 80_000_000);
        if attempt == 1 {
            prog.say(&format!(
                "Plan: grid {} m, cube {:.1} m, {} threads, {} memory, chunks up to {} points, nodes about {} points, sampling {}³, count grid {}³, gzip level {}",
                sc,
                cube as f64 * sc,
                threads,
                fmt_b(mem),
                fmt_n(chunk_points),
                fmt_n(node_points),
                sample_grid,
                cg,
                o.compression
            ));
            // disk check: chunk files + output
            let need_tmp = total_est * rec::REC_SIZE as u64;
            let need_out = total_est * 16;
            let free_out = fs2::available_space(out).unwrap_or(u64::MAX);
            let free_tmp = fs2::available_space(tmp).unwrap_or(u64::MAX);
            let same = free_out == free_tmp;
            prog.say(&format!("Disk: about {} temporary + {} output needed; {} free{}", fmt_b(need_tmp), fmt_b(need_out), fmt_b(free_out), if same { "" } else { " for output" }));
            let short = if same { need_tmp + need_out > free_out } else { need_tmp > free_tmp || need_out > free_out };
            if short && !o.force {
                bail!("Not enough free disk space. Free some space, put temporary files on another drive with --temp, or pass --force to try anyway.");
            }
            if o.dry_run {
                prog.say("Dry run: stopping before reading points.");
                return Ok(None);
            }
        }

        // ----- count pass -----
        let gl = 63 - cg.leading_zeros() as u64;
        let shift = (63 - cube.leading_zeros()) as u64 - gl;
        let ncell = (cg * cg * cg) as usize;
        let counts: Vec<AtomicU32> = (0..ncell).map(|_| AtomicU32::new(0)).collect();
        let outside = AtomicU64::new(0);
        let skipped = AtomicU64::new(0);
        let used = AtomicU64::new(0); // bitmask of non-zero attributes
        let checks: Vec<Mutex<SrcCheck>> = srcs.iter().map(|_| Mutex::new(SrcCheck::default())).collect();
        let tight = Mutex::new([i64::MAX, i64::MAX, i64::MAX, i64::MIN, i64::MIN, i64::MIN]);
        prog.stage("Pass 1 of 2: counting", total_est);
        let r: Vec<Result<()>> = pool.install(|| {
            units
                .par_iter()
                .map(|u| -> Result<()> {
                    let mut out_n = 0u64;
                    let mut ck = SrcCheck::default();
                    let mut t = [i64::MAX, i64::MAX, i64::MAX, i64::MIN, i64::MIN, i64::MIN];
                    let mut m = 0u64;
                    let sk = input::read_unit(
                        srcs,
                        u,
                        g,
                        1 << 18,
                        |b| {
                            for p in b {
                                let c = ((((p.x as u64) >> shift) * cg + ((p.y as u64) >> shift)) * cg + ((p.z as u64) >> shift)) as usize;
                                counts[c.min(ncell - 1)].fetch_add(1, Ordering::Relaxed);
                                let (f, ps) = rec_hash(p);
                                ck.full = ck.full.wrapping_add(f);
                                ck.position = ck.position.wrapping_add(ps);
                                for (k, v) in [p.x, p.y, p.z].iter().enumerate() {
                                    t[k] = t[k].min(*v as i64);
                                    t[k + 3] = t[k + 3].max(*v as i64);
                                }
                                m |= (p.intensity != 0) as u64 | (((p.r | p.g | p.b) != 0) as u64) << 1 | ((p.cls != 0) as u64) << 2 | (((p.ret | p.nret) != 0) as u64) << 3 | ((p.flags != 0) as u64) << 4 | ((p.chan != 0) as u64) << 5 | ((p.user != 0) as u64) << 6 | ((p.scan_angle != 0) as u64) << 7 | ((p.psid != 0) as u64) << 8 | ((p.gps != 0.0) as u64) << 9;
                            }
                            ck.points += b.len() as u64;
                            prog.done.fetch_add(b.len() as u64, Ordering::Relaxed);
                            Ok(())
                        },
                        &mut out_n,
                    )?;
                    if out_n > 0 {
                        outside.fetch_add(out_n, Ordering::Relaxed);
                    }
                    skipped.fetch_add(sk, Ordering::Relaxed);
                    used.fetch_or(m, Ordering::Relaxed);
                    {
                        let mut c = checks[u.src].lock().unwrap();
                        c.points += ck.points;
                        c.full = c.full.wrapping_add(ck.full);
                        c.position = c.position.wrapping_add(ck.position);
                    }
                    let mut tt = tight.lock().unwrap();
                    for k in 0..3 {
                        tt[k] = tt[k].min(t[k]);
                        tt[k + 3] = tt[k + 3].max(t[k + 3]);
                    }
                    Ok(())
                })
                .collect()
        });
        for x in r {
            x?;
        }
        let total: u64 = checks.iter().map(|c| c.lock().unwrap().points).sum();
        if outside.load(Ordering::Relaxed) > 0 {
            if attempt >= 2 {
                bail!("{} points still fall outside the planned extent", outside.load(Ordering::Relaxed));
            }
            prog.say(&format!("{} points lie outside the bounds in the file headers; reading the true bounds and counting again.", fmt_n(outside.load(Ordering::Relaxed))));
            bounds = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
            let bs: Vec<Result<[f64; 6]>> = pool.install(|| units.par_iter().map(|u| input::scan_bounds(srcs, u)).collect());
            for b in bs {
                let b = b?;
                for k in 0..3 {
                    bounds[k] = bounds[k].min(b[k]);
                    bounds[k + 3] = bounds[k + 3].max(b[k + 3]);
                }
            }
            continue;
        }
        if total == 0 {
            bail!("The inputs contain no valid points.");
        }
        if skipped.load(Ordering::Relaxed) > 0 {
            prog.say(&format!("{} points without a valid position were skipped (E57 range-less returns).", fmt_n(skipped.load(Ordering::Relaxed))));
        }
        let used = used.load(Ordering::Relaxed);
        let any_las = srcs.iter().any(|s| s.has.las);
        let dropped = |n: &str| o.drop.iter().any(|d| d.eq_ignore_ascii_case(n));
        let attrs = Attrs {
            intensity: used & 1 != 0 && !dropped("intensity"),
            rgb: used & 2 != 0 && !dropped("rgb"),
            classification: any_las && !dropped("classification"),
            returns: used & 8 != 0 && !dropped("returns"),
            flags: used & 16 != 0 && !dropped("flags"),
            channel: used & 32 != 0 && !dropped("scanner_channel"),
            user_data: used & 64 != 0 && !dropped("user_data"),
            scan_angle: used & 128 != 0 && !dropped("scan_angle"),
            point_source_id: used & 256 != 0 && !dropped("point_source_id"),
            gps_time: used & 512 != 0 && !dropped("gps_time"),
            source: srcs.len() > 1 && !dropped("source"),
        };
        prog.say(&format!("Counted {} points in {}; storing {} bytes per point before compression", fmt_n(total), fmt_dur(prog.t0.lock().unwrap().elapsed().as_secs_f64()), attrs.bytes_per_point()));

        // ----- chunking -----
        let mut levels: Vec<Vec<u64>> = vec![];
        let fine: Vec<u64> = counts.iter().map(|c| c.load(Ordering::Relaxed) as u64).collect();
        drop(counts);
        levels.push(fine);
        let mut sz = cg;
        while sz > 1 {
            let prev = levels.last().unwrap();
            let h = sz / 2;
            let mut v = vec![0u64; (h * h * h) as usize];
            for x in 0..sz {
                for y in 0..sz {
                    for z in 0..sz {
                        v[(((x / 2) * h + y / 2) * h + z / 2) as usize] += prev[((x * sz + y) * sz + z) as usize];
                    }
                }
            }
            levels.push(v);
            sz = h;
        }
        levels.reverse(); // levels[l] has (2^l)^3 cells
        let mut chunks = vec![];
        let mut lut = vec![u32::MAX; ncell];
        fn rec_chunk(levels: &[Vec<u64>], l: usize, c: [u64; 3], maxc: u64, chunks: &mut Vec<Chunk>, lut: &mut [u32], gl: usize) {
            let s = 1u64 << l;
            let n = levels[l][((c[0] * s + c[1]) * s + c[2]) as usize];
            if n == 0 {
                return;
            }
            if n > maxc && l < gl {
                for d in 0..8u64 {
                    rec_chunk(levels, l + 1, [c[0] * 2 + (d & 1), c[1] * 2 + ((d >> 1) & 1), c[2] * 2 + ((d >> 2) & 1)], maxc, chunks, lut, gl);
                }
                return;
            }
            let id = chunks.len() as u32;
            chunks.push(Chunk { name: chunk_name(l as u32, c), count: n });
            let k = 1u64 << (gl - l);
            let fs = 1u64 << gl;
            for x in c[0] * k..(c[0] + 1) * k {
                for y in c[1] * k..(c[1] + 1) * k {
                    for z in c[2] * k..(c[2] + 1) * k {
                        lut[((x * fs + y) * fs + z) as usize] = id;
                    }
                }
            }
        }
        rec_chunk(&levels, 0, [0, 0, 0], chunk_points, &mut chunks, &mut lut, gl as usize);
        drop(levels);
        let biggest = chunks.iter().map(|c| c.count).max().unwrap_or(0);
        prog.say(&format!("{} chunk(s); largest {} points", chunks.len(), fmt_n(biggest)));

        // ----- distribute pass -----
        let cdir = tmp.join("chunks");
        let buf_cap = (mem / 4).clamp(64 << 20, 4 << 30) as usize;
        let (tx, rx) = crossbeam_channel::bounded::<(Vec<u32>, Vec<usize>, Vec<Rec>)>(threads * 2);
        let nch = chunks.len();
        let cdir2 = cdir.clone();
        let writer = std::thread::spawn(move || -> Result<Vec<u64>> {
            let mut bufs: Vec<Vec<u8>> = vec![Vec::new(); nch];
            let mut written = vec![0u64; nch];
            let mut total = 0usize;
            let flush = |i: usize, b: &mut Vec<u8>, written: &mut Vec<u64>| -> Result<()> {
                if b.is_empty() {
                    return Ok(());
                }
                let mut f = OpenOptions::new().create(true).append(true).open(cdir2.join(format!("c{}.bin", i)))?;
                f.write_all(b)?;
                written[i] += (b.len() / rec::REC_SIZE) as u64;
                b.clear();
                b.shrink_to(1 << 16);
                Ok(())
            };
            for (ids, starts, recs) in rx {
                let bytes = rec::as_bytes(&recs);
                for (k, &id) in ids.iter().enumerate() {
                    let (a, b) = (starts[k], starts[k + 1]);
                    bufs[id as usize].extend_from_slice(&bytes[a * rec::REC_SIZE..b * rec::REC_SIZE]);
                    total += (b - a) * rec::REC_SIZE;
                }
                if total > buf_cap {
                    let mut order: Vec<usize> = (0..nch).filter(|&i| !bufs[i].is_empty()).collect();
                    order.sort_by_key(|&i| std::cmp::Reverse(bufs[i].len()));
                    for i in order {
                        if total <= buf_cap / 2 {
                            break;
                        }
                        total -= bufs[i].len();
                        flush(i, &mut bufs[i], &mut written)?;
                    }
                }
            }
            for i in 0..nch {
                flush(i, &mut bufs[i], &mut written)?;
            }
            Ok(written)
        });
        prog.stage("Pass 2 of 2: sorting points into chunks", total);
        let lut = Arc::new(lut);
        let r: Vec<Result<()>> = pool.install(|| {
            units
                .par_iter()
                .map(|u| -> Result<()> {
                    let mut out_n = 0u64;
                    let tx = tx.clone();
                    let lut = lut.clone();
                    input::read_unit(
                        srcs,
                        u,
                        g,
                        1 << 19,
                        |b| {
                            // counting sort of the batch by chunk
                            let mut ids: Vec<u32> = Vec::with_capacity(b.len());
                            for p in b {
                                let c = ((((p.x as u64) >> shift) * cg + ((p.y as u64) >> shift)) * cg + ((p.z as u64) >> shift)) as usize;
                                ids.push(lut[c.min(ncell - 1)]);
                            }
                            let mut order: Vec<u32> = (0..b.len() as u32).collect();
                            order.sort_unstable_by_key(|&i| ids[i as usize]);
                            let mut recs = Vec::with_capacity(b.len());
                            let mut gid = vec![];
                            let mut st = vec![];
                            for (k, &i) in order.iter().enumerate() {
                                let id = ids[i as usize];
                                if gid.last() != Some(&id) {
                                    gid.push(id);
                                    st.push(k);
                                }
                                recs.push(b[i as usize]);
                            }
                            st.push(recs.len());
                            tx.send((gid, st, recs)).map_err(|_| anyhow::anyhow!("chunk writer stopped"))?;
                            prog.done.fetch_add(b.len() as u64, Ordering::Relaxed);
                            Ok(())
                        },
                        &mut out_n,
                    )?;
                    Ok(())
                })
                .collect()
        });
        drop(tx);
        let written = writer.join().map_err(|_| anyhow::anyhow!("chunk writer panicked"))??;
        for x in r {
            x?;
        }
        for (i, c) in chunks.iter().enumerate() {
            if written[i] != c.count {
                bail!("chunk {} received {} points but {} were counted (a source changed between passes?)", c.name, written[i], c.count);
            }
        }
        let tt = *tight.lock().unwrap();
        let plan = Plan {
            offset,
            scale: [sc; 3],
            cube_units: cube,
            count_grid: cg,
            chunk_points,
            node_points,
            sample_grid,
            threads,
            memory_bytes: mem,
            compression: o.compression,
            step: o.step,
            attrs,
            chunks,
            total,
            skipped: skipped.load(Ordering::Relaxed),
            tight: tt,
            checks: checks.into_iter().map(|c| c.into_inner().unwrap()).collect(),
            inputs: files.iter().map(|f| f.display().to_string()).collect(),
        };
        write_state(tmp, "distributed", &plan, json!({}))?;
        prog.say(&format!("Chunks written in {}", fmt_dur(prog.t0.lock().unwrap().elapsed().as_secs_f64())));
        return Ok(Some(plan));
    }
}

#[derive(Serialize, Deserialize)]
struct JournalLine {
    chunk: String,
    nodes: Vec<NodeRec>,
    end: u64,
}

fn index_chunks(plan: &Plan, out: &Path, tmp: &Path, resuming: bool, prog: &Arc<Prog>) -> Result<(Vec<NodeRec>, u64)> {
    let oct_path = out.join("octree.bin");
    let jpath = tmp.join("journal.jsonl");
    let mut done: HashSet<String> = HashSet::new();
    let mut nodes: Vec<NodeRec> = vec![];
    let mut end = 0u64;
    if let Some((stage, _)) = read_state(tmp) {
        if resuming && (stage == "distributed" || stage == "indexed") {
            if let Ok(f) = File::open(&jpath) {
                for l in BufReader::new(f).lines() {
                    let l = l?;
                    if let Ok(j) = serde_json::from_str::<JournalLine>(&l) {
                        done.insert(j.chunk.clone());
                        end = end.max(j.end);
                        nodes.extend(j.nodes);
                    }
                }
            }
            if !done.is_empty() {
                prog.say(&format!("{} of {} chunks already done", done.len(), plan.chunks.len()));
            }
        }
    }
    let f = OpenOptions::new().create(true).read(true).write(true).truncate(!resuming).open(&oct_path)?;
    if resuming {
        f.set_len(end)?;
    } else {
        end = 0;
        let _ = fs::remove_file(&jpath);
    }
    let mut f = f;
    f.seek(SeekFrom::Start(end))?;
    let oct = Mutex::new(OctOut { f, pos: end });
    let journal = Mutex::new(OpenOptions::new().create(true).append(true).open(&jpath)?);
    let todo: Vec<&Chunk> = {
        let mut v: Vec<&Chunk> = plan.chunks.iter().filter(|c| !done.contains(&c.name)).collect();
        v.sort_by_key(|c| std::cmp::Reverse(c.count));
        v
    };
    let left: u64 = todo.iter().map(|c| c.count).sum();
    prog.stage("Building the octree", plan.total);
    prog.done.store(plan.total - left, Ordering::Relaxed);
    let sem = MemSem { cap: ((plan.memory_bytes as f64 * 0.7) / 140.0) as u64, used: Mutex::new(0), cv: Condvar::new() };
    let pool = rayon::ThreadPoolBuilder::new().num_threads(plan.threads).build()?;
    let all = Mutex::new(nodes);
    let r: Vec<Result<()>> = pool.install(|| {
        todo.par_iter()
            .map(|c| -> Result<()> {
                let tok = sem.acquire(c.count);
                let res = (|| -> Result<()> {
                    let p = tmp.join("chunks").join(format!("c{}.bin", plan.chunks.iter().position(|x| x.name == c.name).unwrap()));
                    let mut b = vec![];
                    File::open(&p).with_context(|| format!("opening {}", p.display()))?.read_to_end(&mut b)?;
                    let mut recs = rec::from_bytes(&b);
                    drop(b);
                    if recs.len() as u64 != c.count {
                        bail!("chunk file {} is incomplete", p.display());
                    }
                    shuffle(&mut recs, name_seed(&c.name));
                    let (min, units) = octree::node_cube(&c.name, plan.cube_units);
                    let mut mine: Vec<NodeRec> = vec![];
                    let mut bits = vec![];
                    let is_root_chunk = c.name.len() == 1;
                    // top-down, iterative to keep the stack small
                    let mut stack = vec![(c.name.clone(), min, units, recs)];
                    while let Some((name, min, units, recs)) = stack.pop() {
                        let n = recs.len() as u64;
                        let (keep, rest) = if n <= plan.node_points || units <= 1 || name.len() > 40 { (recs, vec![]) } else { octree::sample(recs, min, units, plan.sample_grid, &mut bits) };
                        if name == c.name && !is_root_chunk {
                            // the chunk root goes upwards: keep it for the upper-level pass
                            let up = tmp.join("up").join(format!("{}.bin", name));
                            let tmpf = up.with_extension("part");
                            fs::write(&tmpf, rec::as_bytes(&keep))?;
                            fs::rename(&tmpf, &up)?;
                        } else {
                            let mut keep = keep;
                            let blob = octree::compress(octree::encode(&mut keep, min, units, &plan.attrs, name.len() as u32 - 1), plan.compression);
                            let (off, size) = oct.lock().unwrap().write(&blob)?;
                            mine.push(NodeRec { name: name.clone(), count: keep.len() as u32, off, size });
                            prog.done.fetch_add(keep.len() as u64, Ordering::Relaxed);
                        }
                        if !rest.is_empty() {
                            let h = units / 2;
                            for (d, kid) in octree::split8(rest, min, units).into_iter().enumerate() {
                                if kid.is_empty() {
                                    continue;
                                }
                                let km = [min[0] + (d as i64 & 1) * h as i64, min[1] + ((d as i64 >> 1) & 1) * h as i64, min[2] + ((d as i64 >> 2) & 1) * h as i64];
                                stack.push((format!("{}{}", name, d), km, h, kid));
                            }
                        }
                    }
                    // commit
                    let end = {
                        let o = oct.lock().unwrap();
                        o.f.sync_data()?;
                        o.pos
                    };
                    {
                        let mut j = journal.lock().unwrap();
                        writeln!(j, "{}", serde_json::to_string(&JournalLine { chunk: c.name.clone(), nodes: mine.clone(), end })?)?;
                        j.flush()?;
                    }
                    let _ = fs::remove_file(&p);
                    all.lock().unwrap().extend(mine);
                    Ok(())
                })();
                sem.release(tok);
                res
            })
            .collect()
    });
    for x in r {
        x?;
    }
    let end = oct.lock().unwrap().pos;
    write_state(tmp, "indexed", plan, json!({"octreeEnd": end}))?;
    prog.say(&format!("Octree built in {}", fmt_dur(prog.t0.lock().unwrap().elapsed().as_secs_f64())));
    Ok((all.into_inner().unwrap(), end))
}

fn upper_levels(plan: &Plan, out: &Path, tmp: &Path, octree_end: u64, prog: &Arc<Prog>) -> Result<Vec<NodeRec>> {
    let roots: Vec<String> = plan.chunks.iter().filter(|c| c.name.len() > 1).map(|c| c.name.clone()).collect();
    if roots.is_empty() {
        return Ok(vec![]);
    }
    let mut upper: HashSet<String> = HashSet::new();
    for r in &roots {
        for l in 1..r.len() {
            upper.insert(r[..l].to_string());
        }
    }
    let mut by_level: Vec<Vec<String>> = vec![vec![]; roots.iter().map(|r| r.len()).max().unwrap()];
    for u in &upper {
        by_level[u.len() - 1].push(u.clone());
    }
    let mut f = OpenOptions::new().read(true).write(true).open(out.join("octree.bin"))?;
    f.set_len(octree_end)?;
    f.seek(SeekFrom::Start(octree_end))?;
    let oct = Mutex::new(OctOut { f, pos: octree_end });
    let held = |n: &str| tmp.join("up").join(format!("{}.bin", n));
    let gen = |n: &str| tmp.join("up").join(format!("{}.u.bin", n)); // written by this pass (re-runnable)
    let nodes = Mutex::new(vec![]);
    prog.stage("Building the upper levels", upper.len() as u64);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(plan.threads).build()?;
    for lvl in (0..by_level.len()).rev() {
        let r: Vec<Result<()>> = pool.install(|| {
            by_level[lvl]
                .par_iter()
                .map(|u| -> Result<()> {
                    let (min, units) = octree::node_cube(u, plan.cube_units);
                    let gl = 63 - plan.sample_grid.leading_zeros();
                    let ul = 63 - units.leading_zeros();
                    let (sh, gg) = if ul >= gl { (ul - gl, plan.sample_grid) } else { (0, units) };
                    let mut bits = vec![0u64; ((gg * gg * gg) as usize).div_ceil(64)];
                    let mut acc = vec![];
                    for d in 0..8 {
                        let k = format!("{}{}", u, d);
                        let p = if upper.contains(&k) { gen(&k) } else { held(&k) };
                        if !p.exists() {
                            continue;
                        }
                        let recs = rec::from_bytes(&fs::read(&p)?);
                        let mut rest = Vec::with_capacity(recs.len());
                        for r in recs {
                            let cx = (((r.x as i64 - min[0]) as u64) >> sh).min(gg - 1);
                            let cy = (((r.y as i64 - min[1]) as u64) >> sh).min(gg - 1);
                            let cz = (((r.z as i64 - min[2]) as u64) >> sh).min(gg - 1);
                            let c = ((cx * gg + cy) * gg + cz) as usize;
                            if bits[c >> 6] & (1 << (c & 63)) == 0 {
                                bits[c >> 6] |= 1 << (c & 63);
                                acc.push(r);
                            } else {
                                rest.push(r);
                            }
                        }
                        let (km, ku) = octree::node_cube(&k, plan.cube_units);
                        let blob = octree::compress(octree::encode(&mut rest, km, ku, &plan.attrs, k.len() as u32 - 1), plan.compression);
                        let (off, size) = oct.lock().unwrap().write(&blob)?;
                        nodes.lock().unwrap().push(NodeRec { name: k.clone(), count: rest.len() as u32, off, size });
                    }
                    if u == "r" {
                        let blob = octree::compress(octree::encode(&mut acc, min, units, &plan.attrs, 0), plan.compression);
                        let (off, size) = oct.lock().unwrap().write(&blob)?;
                        nodes.lock().unwrap().push(NodeRec { name: u.clone(), count: acc.len() as u32, off, size });
                    } else {
                        fs::write(gen(u), rec::as_bytes(&acc))?;
                    }
                    prog.done.fetch_add(1, Ordering::Relaxed);
                    Ok(())
                })
                .collect()
        });
        for x in r {
            x?;
        }
    }
    oct.lock().unwrap().f.sync_all()?;
    Ok(nodes.into_inner().unwrap())
}

#[allow(clippy::too_many_arguments)]
fn finish(o: &Opts, plan: &Plan, srcs: &[Source], files_meta: &[(String, Value)], nodes: Vec<NodeRec>, out: &Path, _tmp: &Path, prog: &Arc<Prog>) -> Result<()> {
    let mut map: HashMap<String, NodeRec> = HashMap::new();
    for n in nodes {
        map.insert(n.name.clone(), n);
    }
    let stored: u64 = map.values().map(|n| n.count as u64).sum();
    if stored != plan.total {
        bail!("internal check failed: {} points stored but {} read", stored, plan.total);
    }
    // every node's parent must exist
    for k in map.keys() {
        if k.len() > 1 && !map.contains_key(&k[..k.len() - 1]) {
            bail!("internal check failed: node {} has no parent", k);
        }
    }
    let (hier, first, depth) = octree::build_hierarchy(&map, plan.step);
    let hp = out.join("hierarchy.bin.tmp");
    fs::write(&hp, &hier)?;
    fs::rename(&hp, out.join("hierarchy.bin"))?;
    let oct_size = fs::metadata(out.join("octree.bin"))?.len();
    let sc = plan.scale[0];
    let t = plan.tight;
    let bmin = [plan.offset[0] + t[0] as f64 * sc, plan.offset[1] + t[1] as f64 * sc, plan.offset[2] + t[2] as f64 * sc];
    let bmax = [plan.offset[0] + t[3] as f64 * sc, plan.offset[1] + t[4] as f64 * sc, plan.offset[2] + t[5] as f64 * sc];
    // CRS: explicit, else the first source that has one
    let crs = match &o.crs {
        Some(c) => {
            let code = c.trim().trim_start_matches("EPSG:").trim_start_matches("epsg:");
            match code.parse::<u64>() {
                Ok(n) => json!({"epsg": n, "source": "command line"}),
                Err(_) => json!({"wkt": c, "source": "command line"}),
            }
        }
        None => srcs.iter().find_map(|s| s.crs.clone()).unwrap_or(Value::Null),
    };
    let name = o.name.clone().unwrap_or_else(|| {
        if srcs.len() == 1 || srcs.iter().all(|s| s.path == srcs[0].path) {
            srcs[0].path.file_stem().unwrap().to_string_lossy().to_string()
        } else {
            out.file_name().unwrap().to_string_lossy().to_string()
        }
    });
    let sources: Vec<Value> = srcs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let c = &plan.checks[i];
            json!({
                "index": i, "label": s.label, "file": s.path.file_name().unwrap().to_string_lossy(), "kind": if s.kind == input::Kind::Las { "las" } else { "e57" },
                "scan": if s.kind == input::Kind::E57 { Some(s.scan) } else { None },
                "points": c.points, "headerPoints": s.points, "bytes": s.bytes, "crs": s.crs,
                "checksum": {"full": format!("{:016x}", c.full), "position": format!("{:016x}", c.position)},
                "metadata": s.meta,
            })
        })
        .collect();
    let files: Vec<Value> = files_meta.iter().map(|(f, m)| json!({"file": f, "metadata": m})).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let ds = json!({
        "format": "scanbench-lod",
        "version": 1,
        "name": name,
        "generator": format!("scanlod {}", env!("CARGO_PKG_VERSION")),
        "created": now,
        "points": plan.total,
        "skippedPoints": plan.skipped,
        "nodes": map.len(),
        "depth": depth,
        "scale": plan.scale,
        "offset": plan.offset,
        "bounds": {"min": bmin, "max": bmax},
        "cube": {"min": plan.offset, "size": plan.cube_units as f64 * sc, "units": plan.cube_units},
        "spacing": plan.cube_units as f64 * sc / plan.sample_grid as f64,
        "nodeNaming": "r, then one digit per level: digit = x | y<<1 | z<<2 (1 = upper half)",
        "crs": crs,
        "attributes": plan.attrs.describe(),
        "bytesPerPoint": plan.attrs.bytes_per_point(),
        "encoding": if plan.compression > 0 { "gzip" } else { "none" },
        "octree": {"file": "octree.bin", "bytes": oct_size},
        "hierarchy": {"file": "hierarchy.bin", "firstChunkSize": first, "stepSize": plan.step, "entryBytes": octree::ENTRY, "bytes": hier.len()},
        "sources": sources,
        "files": files,
        "settings": {
            "threads": plan.threads, "memoryBytes": plan.memory_bytes, "chunkPoints": plan.chunk_points, "chunks": plan.chunks.len(),
            "nodePoints": plan.node_points, "samplingGrid": plan.sample_grid, "countGrid": plan.count_grid, "compressionLevel": plan.compression, "preset": o.preset,
        },
        "seconds": prog.start.elapsed().as_secs_f64(),
    });
    let dp = out.join("dataset.json.tmp");
    fs::write(&dp, serde_json::to_vec_pretty(&ds)?)?;
    fs::rename(&dp, out.join("dataset.json"))?;
    // a viewer in the folder, set to open this project (double-click it; Chrome or Edge)
    {
        let v = String::from_utf8_lossy(crate::serve::VIEWER);
        if v.contains("window.SB_HOME=/*SB_HOME*/null;") {
            let home = format!("window.SB_HOME={};", serde_json::to_string(&json!({"name": name, "points": plan.total, "created": now}))?.replace('<', "\\u003c"));
            fs::write(out.join("ScanBench.html"), v.replacen("window.SB_HOME=/*SB_HOME*/null;", &home, 1))?;
        }
    }
    let pp = out.join("project.json");
    if !pp.exists() {
        let proj = json!({
            "format": "scanbench-project", "version": 1, "name": name, "created": now,
            "datasets": [{"id": "d1", "name": name, "path": "dataset.json", "visible": true}],
            "annotations": [], "measurements": [], "models": [], "views": [], "boxes": [],
        });
        fs::write(&pp, serde_json::to_vec_pretty(&proj)?)?;
    }
    let el = prog.start.elapsed().as_secs_f64();
    prog.say(&format!(
        "Done: {} points in {} nodes, {} levels, octree {} ({:.1} bytes per point), {} at {}/s",
        fmt_n(plan.total),
        map.len(),
        depth + 1,
        fmt_b(oct_size),
        oct_size as f64 / plan.total as f64,
        fmt_dur(el),
        fmt_n((plan.total as f64 / el.max(1e-3)) as u64)
    ));
    prog.say(&format!("Open {} in ScanBench.", out.join("project.json").display()));
    Ok(())
}
