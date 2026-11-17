//! One-click setup of the virtual microphone (VB-Audio Virtual Cable).
//!
//! VoxShift does not ship the driver itself: at the user's request it downloads the official
//! driver pack from vb-audio.com, checks that the installer carries VB-Audio's valid
//! Authenticode signature, and runs it silently (`-i -h`) with administrator rights.
//! Windows still shows its UAC prompt and the driver-trust prompt.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, WAIT_FAILED};
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

const CABLE_PAGE: &str = "https://vb-audio.com/Cable/";
const DOWNLOAD_PREFIX: &str = "https://download.vb-audio.com/Download_CABLE/";
const FALLBACK_PACK: &str = "VBCABLE_Driver_Pack46.zip";
/// Subject of VB-Audio's code-signing certificate (Vincent Burel).
const EXPECTED_SIGNER: &str = "BUREL VINCENT";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn stage(app: &AppHandle, s: &str) {
    let _ = app.emit("cable-setup", s);
}

fn get(url: &str) -> Result<ureq::Response, String> {
    ureq::get(url)
        .set("User-Agent", "VoxShift")
        .call()
        .map_err(|e| format!("Could not reach vb-audio.com: {e}"))
}

/// Finds the newest driver pack linked from the official page.
fn latest_pack_url() -> String {
    let best = get(CABLE_PAGE)
        .ok()
        .and_then(|r| r.into_string().ok())
        .and_then(|html| {
            html.match_indices("VBCABLE_Driver_Pack")
                .filter_map(|(i, _)| {
                    let rest = &html[i + "VBCABLE_Driver_Pack".len()..];
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if rest[digits.len()..].starts_with(".zip") { digits.parse::<u32>().ok() } else { None }
                })
                .max()
        });
    match best {
        Some(n) => format!("{DOWNLOAD_PREFIX}VBCABLE_Driver_Pack{n}.zip"),
        None => format!("{DOWNLOAD_PREFIX}{FALLBACK_PACK}"),
    }
}

fn download_and_extract(url: &str, dir: &Path) -> Result<(), String> {
    let mut bytes = Vec::new();
    get(url)?
        .into_reader()
        .take(20 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Download failed: {e}"))?;
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Bad driver package: {e}"))?;
    archive.extract(dir).map_err(|e| format!("Could not unpack driver: {e}"))?;
    Ok(())
}

/// Returns Ok if the file has a valid Authenticode signature from VB-Audio.
fn verify_signature(exe: &Path) -> Result<(), String> {
    let script = format!(
        "$s = Get-AuthenticodeSignature -LiteralPath '{}'; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)",
        exe.display().to_string().replace('\'', "''")
    );
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Could not check the driver signature: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.trim();
    if line.starts_with("Valid|") && line.contains(EXPECTED_SIGNER) {
        Ok(())
    } else {
        Err("The downloaded driver is not signed by VB-Audio, so it was not installed.".into())
    }
}

/// Runs the installer elevated (UAC prompt) and waits for it. Returns its exit code.
fn run_elevated(exe: &Path, args: &str) -> Result<u32, String> {
    let file = HSTRING::from(exe.as_os_str());
    let dir = HSTRING::from(exe.parent().unwrap_or(Path::new(".")).as_os_str());
    let params = HSTRING::from(args);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        lpDirectory: PCWSTR(dir.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            // 0x800704C7 = ERROR_CANCELLED: the user said No to the UAC prompt.
            return Err(if e.code().0 as u32 == 0x8007_04C7 {
                "Setup was cancelled.".into()
            } else {
                format!("Could not start the driver installer: {e}")
            });
        }
        if info.hProcess.is_invalid() {
            return Ok(0);
        }
        let waited = WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        if waited == WAIT_FAILED {
            return Err("Lost track of the driver installer.".into());
        }
        Ok(code)
    }
}

fn setup_exe(dir: &Path) -> PathBuf {
    let name = if cfg!(target_arch = "x86") { "VBCABLE_Setup.exe" } else { "VBCABLE_Setup_x64.exe" };
    dir.join(name)
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    stage(app, "download");
    let url = latest_pack_url();
    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err("Unexpected download address.".into());
    }
    let dir = std::env::temp_dir().join("VoxShift-VBCABLE");
    download_and_extract(&url, &dir)?;

    stage(app, "verify");
    let exe = setup_exe(&dir);
    if !exe.exists() {
        return Err("Driver installer missing from the package.".into());
    }
    verify_signature(&exe)?;

    stage(app, "install");
    // Developer switch: exercise download + signature check without touching the system.
    if std::env::var_os("VOXSHIFT_CABLE_DRYRUN").is_none() {
        // The VB-Cable installer makes the cable the Windows default speaker and mic, which
        // would silence the user's speakers. Remember the current defaults and put them back.
        let prev_render = crate::winaudio::default_render_id().ok();
        let prev_capture = crate::winaudio::default_capture_id().ok();
        let result = run_elevated(&exe, "-i -h");
        // Windows can switch defaults a moment after the new devices appear, so restore twice.
        for delay in [500u64, 3000] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            for id in [&prev_render, &prev_capture].into_iter().flatten() {
                let _ = crate::winaudio::set_default_endpoint(id);
            }
        }
        result?;
    }
    let _ = std::fs::remove_dir_all(&dir);
    stage(app, "done");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Network test: downloads the real driver pack and checks its signature (does not install).
    #[test]
    #[ignore]
    fn download_and_verify_driver_pack() {
        let url = latest_pack_url();
        assert!(url.starts_with(DOWNLOAD_PREFIX), "{url}");
        let dir = std::env::temp_dir().join("VoxShift-VBCABLE-test");
        download_and_extract(&url, &dir).expect("download");
        let exe = setup_exe(&dir);
        assert!(exe.exists());
        verify_signature(&exe).expect("signature");
        // A file without VB-Audio's signature must be rejected.
        let fake = dir.join("fake.exe");
        std::fs::write(&fake, b"MZ not signed").unwrap();
        assert!(verify_signature(&fake).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        println!("ok: {url}");
    }
}
