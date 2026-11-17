mod convert;
mod input;
mod octree;
mod rec;
mod serve;
mod tools;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

/// ScanBench LOD converter: turns E57, LAS and LAZ scans of any size into a tiled octree that the
/// ScanBench viewer streams. Only the tiles in view are ever loaded, at the detail the view needs.
#[derive(Parser)]
#[command(name = "scanlod", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Convert scans into a LOD dataset folder (dataset.json, project.json, octree.bin, hierarchy.bin).
    Convert {
        /// Input files or folders (.e57, .las, .laz; folders are searched recursively). Several inputs become one dataset.
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// Output folder.
        #[arg(short, long)]
        out: PathBuf,
        /// Dataset name (default: the input file name).
        #[arg(long)]
        name: Option<String>,
        /// Worker threads (default: all cores).
        #[arg(long)]
        threads: Option<usize>,
        /// Memory to use, in GB (default: 60% of this computer's memory).
        #[arg(long)]
        memory: Option<f64>,
        /// Node detail: "fine" (smaller tiles, smoother streaming over slow links), "balanced" (default) or "coarse" (bigger tiles, fewer files requests).
        #[arg(long, default_value = "balanced")]
        preset: String,
        /// Coordinate precision in metres (default: the finest LAS scale, or 0.0001 for E57).
        #[arg(long)]
        scale: Option<f64>,
        /// Points held by a leaf tile before it is split (overrides the preset).
        #[arg(long)]
        node_points: Option<u64>,
        /// Sampling grid per tile edge (power of two; higher = denser tiles). Overrides the preset.
        #[arg(long)]
        sample_grid: Option<u64>,
        /// Points per processing chunk (default: sized from memory and threads).
        #[arg(long)]
        chunk_points: Option<u64>,
        /// Counting grid per axis (default: 128, 256 or 512 by dataset size).
        #[arg(long)]
        count_grid: Option<u64>,
        /// Compression level 0-9 (0 = none; default 4).
        #[arg(long, default_value_t = 4)]
        compression: u32,
        /// Levels per hierarchy page.
        #[arg(long, default_value_t = 4)]
        step: usize,
        /// Folder for temporary files (needs about 40 bytes per point; default: inside the output folder).
        #[arg(long)]
        temp: Option<PathBuf>,
        /// Continue an interrupted run from its last finished chunk.
        #[arg(long)]
        resume: bool,
        /// Replace an existing dataset in the output folder.
        #[arg(long)]
        overwrite: bool,
        /// Keep temporary files after a successful run.
        #[arg(long)]
        keep_temp: bool,
        /// Run even when the disk-space check fails.
        #[arg(long)]
        force: bool,
        /// Coordinate system when the inputs have none, e.g. EPSG:7850.
        #[arg(long)]
        crs: Option<String>,
        /// Attributes to leave out, comma separated (intensity, rgb, classification, returns, flags, scanner_channel, user_data, scan_angle, point_source_id, gps_time, source).
        #[arg(long, value_delimiter = ',')]
        drop: Vec<String>,
        /// Read headers, print the plan and stop.
        #[arg(long)]
        dry_run: bool,
    },
    /// Open a project folder in the ScanBench viewer (a local web server; your browser opens it).
    View {
        /// Project folder (with project.json or dataset.json).
        folder: PathBuf,
        /// Port to listen on.
        #[arg(long, default_value_t = 8765)]
        port: u16,
        /// Address to listen on (0.0.0.0 shares it on your network).
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Do not open a browser.
        #[arg(long)]
        no_open: bool,
        /// Do not allow saving project.json or models from the viewer.
        #[arg(long)]
        read_only: bool,
    },
    /// Summarise a dataset.
    Info { dataset: PathBuf },
    /// Check that every point is stored exactly once and unchanged (against checksums taken while converting).
    Verify { dataset: PathBuf },
    /// Export the whole dataset, a 3D box or one source to LAS or LAZ at full resolution.
    Export {
        dataset: PathBuf,
        /// Output .las or .laz file.
        #[arg(short, long)]
        out: PathBuf,
        /// Box in world coordinates: minX,minY,minZ,maxX,maxY,maxZ.
        #[arg(long, allow_hyphen_values = true)]
        r#box: Option<String>,
        /// Only this source (index in dataset.json "sources").
        #[arg(long)]
        source: Option<u16>,
        /// Only tiles down to this level (a thinned export).
        #[arg(long)]
        max_level: Option<usize>,
    },
}

fn main() {
    let cli = Cli::parse();
    let r = match cli.cmd {
        Cmd::Convert { inputs, out, name, threads, memory, preset, scale, node_points, sample_grid, chunk_points, count_grid, compression, step, temp, resume, overwrite, keep_temp, force, crs, drop, dry_run } => convert::run(convert::Opts {
            inputs,
            out,
            name,
            threads,
            memory_gb: memory,
            preset,
            scale,
            node_points,
            sample_grid,
            chunk_points,
            count_grid,
            compression,
            step: step.clamp(2, 8),
            temp,
            resume,
            overwrite,
            keep_temp,
            force,
            crs,
            drop,
            dry_run,
        }),
        Cmd::View { folder, port, host, no_open, read_only } => serve::run(&folder, &host, port, !no_open, read_only),
        Cmd::Info { dataset } => tools::info(&dataset),
        Cmd::Verify { dataset } => tools::verify(&dataset),
        Cmd::Export { dataset, out, r#box, source, max_level } => (|| {
            let b = match r#box {
                None => None,
                Some(s) => {
                    let v: Vec<f64> = s.split(',').map(|x| x.trim().parse::<f64>()).collect::<Result<_, _>>().map_err(|_| anyhow::anyhow!("--box needs six numbers: minX,minY,minZ,maxX,maxY,maxZ"))?;
                    if v.len() != 6 {
                        anyhow::bail!("--box needs six numbers: minX,minY,minZ,maxX,maxY,maxZ");
                    }
                    Some([v[0], v[1], v[2], v[3], v[4], v[5]])
                }
            };
            tools::export(&dataset, &out, b, source, max_level)
        })(),
    };
    if let Err(e) = r {
        eprintln!("Error: {:#}", e);
        std::process::exit(1);
    }
}
