// Predict first: does this compile? If not, which error code? Then make it
// compile so it prints "[Spices]" by writing LESS, not more: this function
// takes one reference and returns one.

fn tidy<'a>(label: &str) -> &'a str {
    label.trim()
}

fn main() {
    let raw = String::from("   Spices  ");
    println!("[{}]", tidy(&raw));
}
