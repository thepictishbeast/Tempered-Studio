// Predict first: the three arms clearly cover every whole number. Does the
// compiler agree? If not, which error code, and which values does it say are
// missing? Then make it compile without changing what it prints for any value.

fn describe(change: i32) -> &'static str {
    match change {
        n if n > 0 => "went up",
        n if n < 0 => "went down",
        0 => "stayed the same",
    }
}

fn main() {
    println!("The price {}", describe(-3));
}
