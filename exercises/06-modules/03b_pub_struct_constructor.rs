// Predict first: `Locker` is `pub` — can `main` build one with a struct
// literal? If not, which error code? Then make it compile WITHOUT making `pin`
// public: the `gym` module should be the only code that ever sets a PIN.

mod gym {
    pub struct Locker {
        pub number: u32,
        pin: u32,
    }

    impl Locker {
        pub fn opens_with(&self, code: u32) -> bool {
            self.pin == code
        }
    }
}

fn main() {
    let locker = gym::Locker { number: 12, pin: 4821 };
    println!("Locker {} opens with 4821: {}", locker.number, locker.opens_with(4821));
}
