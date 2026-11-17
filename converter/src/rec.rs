//! The fixed-size point record used inside the converter (temporary chunk files and in memory).
use bytemuck::{Pod, Zeroable};

/// 40 bytes. Positions are integers on the dataset grid (offset + scale), so every source point
/// keeps its exact position. Attributes cover everything in LAS 1.4 point formats 0-10 except
/// waveform packets, NIR and extra bytes (reported in dataset.json when a source had them).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default, Debug, PartialEq)]
pub struct Rec {
    pub gps: f64,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub intensity: u16,
    pub r: u16,
    pub g: u16,
    pub b: u16,
    pub psid: u16,
    pub scan_angle: i16, // 0.006 degree units (LAS 1.4)
    pub src: u16,        // index into dataset.json "sources"
    pub cls: u8,
    pub ret: u8,
    pub nret: u8,
    pub flags: u8, // bit0 synthetic, bit1 key-point, bit2 withheld, bit3 overlap, bit4 scan direction, bit5 edge of flight line
    pub user: u8,
    pub chan: u8, // scanner channel
}
pub const REC_SIZE: usize = std::mem::size_of::<Rec>();
const _: () = assert!(REC_SIZE == 40);

pub fn as_bytes(r: &[Rec]) -> &[u8] {
    bytemuck::cast_slice(r)
}
pub fn from_bytes(b: &[u8]) -> Vec<Rec> {
    let n = b.len() / REC_SIZE;
    let mut v = vec![Rec::default(); n];
    bytemuck::cast_slice_mut::<Rec, u8>(&mut v).copy_from_slice(&b[..n * REC_SIZE]);
    v
}
