// Predict first: does this compile? If not, which error code, and which name in
// `main` can't the compiler find? Then fix the call in `main` so it prints
// "Table for 2 is ready" — leave both modules as they are.

mod restaurant {
    pub mod seating {
        pub fn ready(guests: u32) {
            println!("Table for {guests} is ready");
        }
    }
}

fn main() {
    seating::ready(2);
}
