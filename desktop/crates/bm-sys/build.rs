// Builds libbmffi.dylib with the engine's own CMake tree (native/build-rust) and links it.
use std::path::PathBuf;
use std::process::Command;

fn run(cmd: &mut Command) {
    let status = cmd.status().unwrap_or_else(|e| panic!("could not run {cmd:?}: {e}"));
    assert!(status.success(), "{cmd:?} failed with {status}");
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../../..").canonicalize().unwrap();
    let native = repo.join("native");
    let build = native.join("build-rust");
    if !build.join("CMakeCache.txt").exists() {
        run(Command::new("cmake").arg("-S").arg(&native).arg("-B").arg(&build).args(["-G", "Ninja", "-DBM_APP_LIB=ON"]));
    }
    run(Command::new("cmake").arg("--build").arg(&build).args(["--target", "bmffi"]));

    let lib = build.join("bmffi");
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-lib=dylib=bmffi");
    // For bm-sys's own test binary; dependents add the same rpath from DEP_BMFFI_LIBDIR.
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    println!("cargo:libdir={}", lib.display()); // DEP_BMFFI_LIBDIR for the app crate
    for dir in ["desktop/bmffi", "native/app/bmapp/src", "native/app/bmapp/include"] {
        println!("cargo:rerun-if-changed={}", repo.join(dir).display());
    }
}
