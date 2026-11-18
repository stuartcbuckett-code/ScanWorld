//! `scanlod view`: a small local web server for the ScanBench viewer and a project folder.
//! GET/HEAD with byte ranges for the data, PUT (same-origin only) to save project.json, models and edits (edits.bin, edits.json).
use anyhow::{Context, Result};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};

pub static VIEWER: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/viewer.html"));

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "json" => "application/json",
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "stl" => "model/stl",
        "obj" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = percent_decode(rel);
    let p = Path::new(&rel);
    let mut out = root.to_path_buf();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn respond(s: &mut TcpStream, code: u16, reason: &str, headers: &[(&str, String)], body: &[u8], head_only: bool) -> std::io::Result<()> {
    let mut h = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nAccept-Ranges: bytes\r\n", code, reason, body.len());
    for (k, v) in headers {
        h.push_str(&format!("{}: {}\r\n", k, v));
    }
    h.push_str("\r\n");
    s.write_all(h.as_bytes())?;
    if !head_only {
        s.write_all(body)?;
    }
    Ok(())
}

fn handle(mut s: TcpStream, root: PathBuf, writable: bool) -> std::io::Result<()> {
    s.set_nodelay(true).ok();
    let mut rd = BufReader::new(s.try_clone()?);
    loop {
        let mut line = String::new();
        if rd.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("/").to_string());
        let mut range: Option<(u64, Option<u64>)> = None;
        let mut clen = 0u64;
        let mut marker = false;
        let mut close = false;
        loop {
            let mut h = String::new();
            if rd.read_line(&mut h)? == 0 {
                return Ok(());
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
                match k.as_str() {
                    "range" => {
                        if let Some(r) = v.strip_prefix("bytes=") {
                            if let Some((a, b)) = r.split_once('-') {
                                if let Ok(a) = a.parse::<u64>() {
                                    range = Some((a, b.parse::<u64>().ok()));
                                }
                            }
                        }
                    }
                    "content-length" => clen = v.parse().unwrap_or(0),
                    "x-scanbench" => marker = true,
                    "connection" => close = v.eq_ignore_ascii_case("close"),
                    _ => {}
                }
            }
        }
        let path = target.split('?').next().unwrap_or("/").to_string();
        let head = method == "HEAD";
        if method == "PUT" {
            let mut body = vec![0u8; clen.min(1 << 30) as usize];
            rd.read_exact(&mut body)?;
            let lower = path.to_ascii_lowercase();
            let ok_ext = lower.ends_with(".json") || lower.ends_with(".stl") || lower.ends_with(".obj") || lower.ends_with("/edits.bin") || lower == "/data/edits.bin";
            match (writable && marker && ok_ext, path.strip_prefix("/data/").and_then(|r| safe_join(&root, r))) {
                (true, Some(p)) if !p.ends_with("dataset.json") => {
                    if let Some(dir) = p.parent() {
                        fs::create_dir_all(dir)?;
                    }
                    let tmp = p.with_file_name(format!("{}.saving", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
                    fs::write(&tmp, &body)?;
                    fs::rename(&tmp, &p)?;
                    eprintln!("saved {}", p.display());
                    respond(&mut s, 200, "OK", &[], b"saved", false)?;
                }
                _ => respond(&mut s, 403, "Forbidden", &[], b"not allowed", false)?,
            }
        } else if method == "GET" || head {
            if path == "/" || path == "/index.html" {
                respond(&mut s, 200, "OK", &[("Content-Type", "text/html; charset=utf-8".into())], VIEWER, head)?;
            } else if let Some(p) = path.strip_prefix("/data/").and_then(|r| safe_join(&root, r)) {
                match File::open(&p) {
                    Ok(mut f) if p.is_file() => {
                        let size = f.metadata()?.len();
                        let ct = mime(&p).to_string();
                        if let Some((a, b)) = range {
                            let end = b.unwrap_or(size.saturating_sub(1)).min(size.saturating_sub(1));
                            if a >= size || end < a {
                                respond(&mut s, 416, "Range Not Satisfiable", &[("Content-Range", format!("bytes */{}", size))], b"", head)?;
                            } else {
                                let n = end - a + 1;
                                let mut buf = vec![0u8; n as usize];
                                f.seek(SeekFrom::Start(a))?;
                                f.read_exact(&mut buf)?;
                                respond(&mut s, 206, "Partial Content", &[("Content-Type", ct), ("Content-Range", format!("bytes {}-{}/{}", a, end, size))], &buf, head)?;
                            }
                        } else if size > 512 << 20 {
                            // stream big files without holding them in memory
                            let h = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\n\r\n", size, ct);
                            s.write_all(h.as_bytes())?;
                            if !head {
                                std::io::copy(&mut f, &mut s)?;
                            }
                        } else {
                            let mut b = Vec::with_capacity(size as usize);
                            f.read_to_end(&mut b)?;
                            respond(&mut s, 200, "OK", &[("Content-Type", ct)], &b, head)?;
                        }
                    }
                    _ => respond(&mut s, 404, "Not Found", &[], b"not found", head)?,
                }
            } else {
                respond(&mut s, 404, "Not Found", &[], b"not found", head)?;
            }
        } else {
            respond(&mut s, 405, "Method Not Allowed", &[], b"", false)?;
        }
        if close {
            return Ok(());
        }
    }
}

pub fn run(folder: &Path, host: &str, port: u16, open: bool, read_only: bool) -> Result<()> {
    let root = folder.canonicalize().with_context(|| format!("{} not found", folder.display()))?;
    let start = if root.join("project.json").exists() {
        "data/project.json"
    } else if root.join("dataset.json").exists() {
        "data/dataset.json"
    } else {
        anyhow::bail!("{} has no project.json or dataset.json (make one with: scanlod convert … -o {})", root.display(), root.display());
    };
    let mut lst = None;
    for p in port..port + 20 {
        if let Ok(l) = TcpListener::bind((host, p)) {
            lst = Some((l, p));
            break;
        }
    }
    let (lst, p) = lst.context("no free port")?;
    let shown = if host == "0.0.0.0" { "127.0.0.1" } else { host };
    let url = format!("http://{}:{}/?project={}", shown, p, start);
    eprintln!("ScanBench viewer for {}\n  {}\n{}Press Ctrl+C to stop.", root.display(), url, if read_only { "  (read only)\n" } else { "" });
    if open {
        let _ = if cfg!(target_os = "windows") {
            std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn()
        } else if cfg!(target_os = "macos") {
            std::process::Command::new("open").arg(&url).spawn()
        } else {
            std::process::Command::new("xdg-open").arg(&url).spawn()
        };
    }
    for c in lst.incoming() {
        if let Ok(c) = c {
            let r = root.clone();
            std::thread::spawn(move || {
                let _ = handle(c, r, !read_only);
            });
        }
    }
    Ok(())
}
