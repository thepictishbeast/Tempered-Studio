// Predict first: does this compile? If not, which error code, and which value
// does the compiler say the parameter's pattern can't handle? Then fix it: keep
// `announce` taking an `Option<u8>`, and make it print "Battery level unknown"
// when there is no reading.

fn announce(Some(level): Option<u8>) {
    println!("Battery at {level}%");
}

fn main() {
    announce(Some(80));
    announce(None);
}
