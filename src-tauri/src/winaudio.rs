//! Windows default-microphone switching (MMDevice API + the undocumented IPolicyConfig).
//! Used to make the virtual cable carrying VoxShift's output the system-wide default mic,
//! so every app that uses "Default" picks up the changed voice.
#![allow(non_snake_case)]

use serde::Serialize;
use std::ffi::c_void;
use windows::core::{interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eMultimedia, ERole, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};

#[derive(Serialize, Clone, Debug)]
pub struct CaptureDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: IUnknown {
    fn GetMixFormat(&self, id: PCWSTR, fmt: *mut *mut c_void) -> HRESULT;
    fn GetDeviceFormat(&self, id: PCWSTR, default: i32, fmt: *mut *mut c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, id: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, id: PCWSTR, fmt: *mut c_void, mix: *mut c_void) -> HRESULT;
    fn GetProcessingPeriod(&self, id: PCWSTR, default: i32, a: *mut i64, b: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, id: PCWSTR, period: *mut i64) -> HRESULT;
    fn GetShareMode(&self, id: PCWSTR, mode: *mut c_void) -> HRESULT;
    fn SetShareMode(&self, id: PCWSTR, mode: *mut c_void) -> HRESULT;
    fn GetPropertyValue(&self, id: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
    fn SetPropertyValue(&self, id: PCWSTR, key: *const c_void, value: *const c_void) -> HRESULT;
    fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
    fn SetEndpointVisibility(&self, id: PCWSTR, visible: i32) -> HRESULT;
}

const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

fn com_init() {
    // Ignore "already initialised in another mode" — COM is usable either way.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    com_init();
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn pwstr_to_string(p: windows::core::PWSTR) -> String {
    let s = unsafe { p.to_string().unwrap_or_default() };
    unsafe { CoTaskMemFree(Some(p.0 as *const c_void)) };
    s
}

pub fn default_capture_id() -> windows::core::Result<String> {
    let en = enumerator()?;
    let dev = unsafe { en.GetDefaultAudioEndpoint(eCapture, eConsole)? };
    Ok(pwstr_to_string(unsafe { dev.GetId()? }))
}

pub fn list_capture() -> windows::core::Result<Vec<CaptureDevice>> {
    let en = enumerator()?;
    let default_id = default_capture_id().unwrap_or_default();
    let coll = unsafe { en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)? };
    let count = unsafe { coll.GetCount()? };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let dev = unsafe { coll.Item(i)? };
        let id = pwstr_to_string(unsafe { dev.GetId()? });
        let name = unsafe {
            dev.OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .map(|v| v.to_string())
                .unwrap_or_default()
        };
        out.push(CaptureDevice { is_default: id == default_id, id, name });
    }
    Ok(out)
}

pub fn set_default_capture(id: &str) -> windows::core::Result<()> {
    com_init();
    let policy: IPolicyConfig = unsafe { CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL)? };
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    for role in [eConsole, eMultimedia, eCommunications] {
        unsafe { policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role).ok()? };
    }
    Ok(())
}
