fn main() {
    let bits: u32 = std::env::args().nth(1).unwrap().parse().unwrap();
    let t = std::time::Instant::now();
    let k = p7_bsgs::worst_case(bits);
    println!("bits {bits}: found {k} in {:?}", t.elapsed());
}
