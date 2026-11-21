//! P7 spike: the lender's baby-step giant-step search for c' in [1, C], C < 2^bits:
//! k·base = target. Throwaway. No randomness, so it builds for wasm32-unknown-unknown with no
//! imports.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use k256::elliptic_curve::group::Curve;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::{AffinePoint, ProjectivePoint, Scalar};

/// The key is already 8 bytes of an x-coordinate: no further hashing.
#[derive(Default)]
pub struct IdHasher(u64);
impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, _: &[u8]) {
        unreachable!()
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = v;
    }
}

const CHUNK: usize = 4096;

fn key(p: &AffinePoint) -> u64 {
    u64::from_be_bytes(p.x()[..8].try_into().unwrap())
}

/// Finds k in [0, max] with k·base = target.
pub fn bsgs(target: ProjectivePoint, base: ProjectivePoint, max: u64) -> Option<u64> {
    let m = ((max as f64).sqrt() as u64 + 1).next_power_of_two();
    let mut table: HashMap<u64, u32, BuildHasherDefault<IdHasher>> =
        HashMap::with_capacity_and_hasher(m as usize, Default::default());
    let mut cur = ProjectivePoint::IDENTITY;
    let mut j = 0u64;
    let mut pts = Vec::with_capacity(CHUNK);
    let mut aff = vec![AffinePoint::IDENTITY; CHUNK];
    while j < m {
        let n = CHUNK.min((m - j) as usize);
        pts.clear();
        for _ in 0..n {
            pts.push(cur);
            cur += base;
        }
        ProjectivePoint::batch_normalize(&pts, &mut aff[..n]);
        for (t, a) in aff[..n].iter().enumerate() {
            table.entry(key(a)).or_insert((j + t as u64) as u32);
        }
        j += n as u64;
    }
    let giant = -(base * Scalar::from(m));
    let mut cur = target;
    let mut i = 0u64;
    while i * m <= max {
        pts.clear();
        for _ in 0..CHUNK {
            pts.push(cur);
            cur += giant;
        }
        ProjectivePoint::batch_normalize(&pts, &mut aff);
        for (t, a) in aff.iter().enumerate() {
            if let Some(&jj) = table.get(&key(a)) {
                let k = (i + t as u64) * m + u64::from(jj);
                if base * Scalar::from(k) == target {
                    return Some(k);
                }
            }
        }
        i += CHUNK as u64;
    }
    None
}

/// Worst case for `bits`: k = 2^bits − 1, base = 7·G (any point whose log nobody needs).
pub fn worst_case(bits: u32) -> u64 {
    let base = ProjectivePoint::GENERATOR * Scalar::from(7u64);
    let k = (1u64 << bits) - 1;
    bsgs(base * Scalar::from(k), base, k).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn run(bits: u32) -> u64 {
    worst_case(bits)
}
