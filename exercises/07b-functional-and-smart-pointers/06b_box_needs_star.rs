// Predict first: does this compile? If not, which error code, and what type does
// the compiler say `price` is? Then make it compile so it prints
// "Three tickets cost 36" — keep `price` in its box.

fn main() {
    let price = Box::new(12);
    let total = price * 3;
    println!("Three tickets cost {total}");
}
