// Embeds the ScanBench viewer (one offline HTML file) so `scanlod view` needs nothing else.
use std::path::Path;
fn main() {
    let out = std::env::var("OUT_DIR").unwrap();
    let src = Path::new("../dist/ScanBench-offline.html");
    println!("cargo:rerun-if-changed=../dist/ScanBench-offline.html");
    let dst = Path::new(&out).join("viewer.html");
    if src.exists() {
        std::fs::copy(src, &dst).unwrap();
    } else {
        std::fs::write(&dst, "<!doctype html><title>ScanBench</title><p>This scanlod build has no viewer inside. Build the viewer first (python3 build.py), then rebuild scanlod.</p>").unwrap();
    }
}
