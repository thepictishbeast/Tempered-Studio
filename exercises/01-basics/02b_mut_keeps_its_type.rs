// Predict first: does this compile? If not, which error code will it show?
// Then make it compile so it prints "Laps: 3" and then "Laps: 4" — keep the
// `mut`, and keep `laps` a whole number.

fn main() {
    let mut laps = 3;
    println!("Laps: {laps}");
    laps = "4";
    println!("Laps: {laps}");
}
