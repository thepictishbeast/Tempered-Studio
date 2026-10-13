// Predict first: does this compile? If not, which error code, and why can't this
// order be shipped yet? Then make `main` take the order through its stages so it
// prints "Order 7 shipped" — leave the types and their methods as they are.

struct UnpaidOrder {
    id: u32,
}

struct PaidOrder {
    id: u32,
}

struct ShippedOrder {
    id: u32,
}

impl UnpaidOrder {
    fn pay(self) -> PaidOrder {
        PaidOrder { id: self.id }
    }
}

impl PaidOrder {
    fn ship(self) -> ShippedOrder {
        ShippedOrder { id: self.id }
    }
}

impl ShippedOrder {
    fn report(&self) -> String {
        format!("Order {} shipped", self.id)
    }
}

fn main() {
    let order = UnpaidOrder { id: 7 };
    let shipped = order.ship();
    println!("{}", shipped.report());
}
