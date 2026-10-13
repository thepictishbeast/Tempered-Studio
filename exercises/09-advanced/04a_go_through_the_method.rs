// Predict first: does this compile? If not, which error code? Then make it
// compile so it prints "Balance: 150" — leave the `bank` module unchanged.
// Ask yourself why `bank` wants every deposit to go through one door.

mod bank {
    pub struct Account {
        balance: u32,
        deposits: Vec<u32>,
    }

    impl Account {
        pub fn new() -> Account {
            Account { balance: 0, deposits: Vec::new() }
        }

        pub fn deposit(&mut self, amount: u32) {
            self.deposits.push(amount);
            self.recalculate();
        }

        pub fn balance(&self) -> u32 {
            self.balance
        }

        fn recalculate(&mut self) {
            self.balance = self.deposits.iter().sum();
        }
    }
}

fn main() {
    let mut account = bank::Account::new();
    account.deposit(100);
    account.deposits.push(50);
    println!("Balance: {}", account.balance());
}
