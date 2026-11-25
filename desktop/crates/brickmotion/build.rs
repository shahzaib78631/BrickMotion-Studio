// Link arguments don't flow from bm-sys to dependents, so the app gets the bmffi rpath here.
fn main() {
    if let Ok(dir) = std::env::var("DEP_BMFFI_LIBDIR") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}
