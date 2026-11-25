// Link arguments don't flow to dependents, so bm's own tests and examples get the rpath here.
fn main() {
    if let Ok(dir) = std::env::var("DEP_BMFFI_LIBDIR") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}
