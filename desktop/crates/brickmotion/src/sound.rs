//! Live transport snap-sound playback and off-thread sample preview.
//! Mirrors `TransportSound.swift`: regenerates the WAV when the plan or mix changes, syncs
//! within 80 ms during playback, and warns once if the audio device cannot open.
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bm::settings::{SnapExample, SnapMix};

use crate::notices::Notice;
use crate::transport::Transport;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_wav_path(tag: &str) -> PathBuf {
    let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("bm-snap-{tag}-{}-{n}.wav", std::process::id()))
}

/// Parses a RIFF/WAVE PCM buffer and returns `(duration_seconds, sample_rate, channels, bits_per_sample, data_slice)`.
fn parse_wav(wav: &[u8]) -> Option<(f64, u32, u16, u16, &[u8])> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let mut sample_rate = 0u32;
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes(wav[pos + 4..pos + 8].try_into().ok()?) as usize;
        pos += 8;
        let end = (pos + size).min(wav.len());
        if id == b"fmt " && end - pos >= 16 {
            channels = u16::from_le_bytes([wav[pos + 2], wav[pos + 3]]);
            sample_rate = u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]);
            bits = u16::from_le_bytes([wav[pos + 14], wav[pos + 15]]);
        } else if id == b"data" {
            data = Some(&wav[pos..end]);
        }
        pos = end + (size & 1);
    }
    let bytes = data?;
    let bytes_per_frame = (channels as usize) * ((bits as usize) / 8);
    if sample_rate == 0 || bytes_per_frame == 0 {
        return None;
    }
    let frames = bytes.len() / bytes_per_frame;
    Some((frames as f64 / sample_rate as f64, sample_rate, channels, bits, bytes))
}

/// Duration of a WAV buffer in seconds.
pub fn wav_duration(wav: &[u8]) -> f64 {
    parse_wav(wav).map_or(0.0, |p| p.0)
}

/// Extracts `bars` normalized peak amplitudes (0..=1) from a 16-bit PCM WAV buffer.
pub fn wav_peaks(wav: &[u8], bars: usize) -> Vec<f32> {
    if bars == 0 {
        return Vec::new();
    }
    let Some((_, _, channels, bits, data)) = parse_wav(wav) else {
        return vec![0.0; bars];
    };
    if bits != 16 || channels == 0 || data.len() < 2 {
        return vec![0.0; bars];
    }
    let stride = (channels as usize) * 2;
    let frames = data.len() / stride;
    if frames == 0 {
        return vec![0.0; bars];
    }
    let mut out = vec![0.0f32; bars];
    let mut max_peak = 0.0f32;
    for (b, slot) in out.iter_mut().enumerate() {
        let f0 = (b * frames) / bars;
        let f1 = (((b + 1) * frames) / bars).max(f0 + 1).min(frames);
        let mut peak = 0.0f32;
        for f in f0..f1 {
            let off = f * stride;
            let sample = i16::from_le_bytes([data[off], data[off + 1]]).unsigned_abs() as f32 / 32768.0;
            if sample > peak {
                peak = sample;
            }
        }
        *slot = peak;
        if peak > max_peak {
            max_peak = peak;
        }
    }
    if max_peak > 1e-4 {
        for v in &mut out {
            *v = (*v / max_peak).clamp(0.0, 1.0);
        }
    }
    out
}

/// Abstraction over audio playback so tests can verify transport sync and device errors deterministically.
pub trait Sink {
    fn load(&mut self, wav: Vec<u8>) -> Result<f64, String>;
    fn play(&mut self) -> Result<(), String>;
    fn pause(&mut self);
    fn is_playing(&self) -> bool;
    fn position(&self) -> f64;
    fn seek(&mut self, seconds: f64);
    fn set_speed(&mut self, rate: f64);
    fn duration(&self) -> f64;
    fn play_preview(&mut self, wav: Vec<u8>) -> Result<(), String>;
}

/// Real audio sink backed by `rodio`. Opens the default device lazily on first sound.
#[derive(Default)]
pub struct RodioSink {
    device: Option<rodio::MixerDeviceSink>,
    track: Option<rodio::Player>,
    preview: Option<rodio::Player>,
    wav: Vec<u8>,
    dur: f64,
    speed: f64,
}

impl RodioSink {
    fn ensure_device(&mut self) -> Result<(), String> {
        if self.device.is_none() {
            let mut dev = rodio::DeviceSinkBuilder::open_default_sink().map_err(|e| e.to_string())?;
            dev.log_on_drop(false);
            let track = rodio::Player::connect_new(dev.mixer());
            track.pause();
            let preview = rodio::Player::connect_new(dev.mixer());
            self.device = Some(dev);
            self.track = Some(track);
            self.preview = Some(preview);
            if self.speed <= 0.0 {
                self.speed = 1.0;
            }
        }
        Ok(())
    }

    fn reload_track(&mut self) -> Result<(), String> {
        self.ensure_device()?;
        let source = rodio::Decoder::new_wav(Cursor::new(self.wav.clone())).map_err(|e| e.to_string())?;
        if let Some(p) = &self.track {
            p.clear();
            p.pause();
            p.set_speed(self.speed.max(0.1) as f32);
            p.append(source);
        }
        Ok(())
    }
}

impl Sink for RodioSink {
    fn load(&mut self, wav: Vec<u8>) -> Result<f64, String> {
        self.dur = wav_duration(&wav);
        self.wav = wav;
        self.reload_track()?;
        Ok(self.dur)
    }

    fn play(&mut self) -> Result<(), String> {
        self.ensure_device()?;
        if let Some(p) = &self.track {
            if p.empty() && !self.wav.is_empty() {
                self.reload_track()?;
            }
            if let Some(p) = &self.track {
                p.play();
            }
        }
        Ok(())
    }

    fn pause(&mut self) {
        if let Some(p) = &self.track {
            p.pause();
        }
    }

    fn is_playing(&self) -> bool {
        self.track.as_ref().is_some_and(|p| !p.is_paused() && !p.empty())
    }

    fn position(&self) -> f64 {
        self.track.as_ref().map_or(0.0, |p| p.get_pos().as_secs_f64())
    }

    fn seek(&mut self, seconds: f64) {
        let clamped = seconds.clamp(0.0, self.dur.max(0.0));
        if let Some(p) = &self.track
            && p.empty()
            && !self.wav.is_empty()
        {
            let _ = self.reload_track();
        }
        if let Some(p) = &self.track {
            let _ = p.try_seek(Duration::from_secs_f64(clamped));
        }
    }

    fn set_speed(&mut self, rate: f64) {
        self.speed = rate.clamp(0.1, 4.0);
        if let Some(p) = &self.track {
            p.set_speed(self.speed as f32);
        }
    }

    fn duration(&self) -> f64 {
        self.dur
    }

    fn play_preview(&mut self, wav: Vec<u8>) -> Result<(), String> {
        self.ensure_device()?;
        let source = rodio::Decoder::new_wav(Cursor::new(wav)).map_err(|e| e.to_string())?;
        if let Some(p) = &self.preview {
            p.clear();
            p.append(source);
            p.play();
        }
        Ok(())
    }
}

/// Deterministic in-memory sink for integration tests.
#[doc(hidden)]
#[derive(Default, Debug)]
pub struct FakeSink {
    pub loads: usize,
    pub plays: usize,
    pub pauses: usize,
    pub seeks: Vec<f64>,
    pub speeds: Vec<f64>,
    pub previews: usize,
    pub playing: bool,
    pub pos: f64,
    pub dur: f64,
    pub speed: f64,
    pub fail_with: Option<String>,
}

impl Sink for FakeSink {
    fn load(&mut self, wav: Vec<u8>) -> Result<f64, String> {
        if let Some(err) = &self.fail_with {
            return Err(err.clone());
        }
        self.loads += 1;
        self.dur = wav_duration(&wav);
        self.pos = 0.0;
        self.playing = false;
        Ok(self.dur)
    }

    fn play(&mut self) -> Result<(), String> {
        if let Some(err) = &self.fail_with {
            return Err(err.clone());
        }
        self.plays += 1;
        self.playing = true;
        Ok(())
    }

    fn pause(&mut self) {
        if self.playing {
            self.pauses += 1;
        }
        self.playing = false;
    }

    fn is_playing(&self) -> bool {
        self.playing
    }

    fn position(&self) -> f64 {
        self.pos
    }

    fn seek(&mut self, seconds: f64) {
        self.pos = seconds.clamp(0.0, self.dur.max(0.0));
        self.seeks.push(self.pos);
    }

    fn set_speed(&mut self, rate: f64) {
        if (self.speed - rate).abs() > 1e-9 {
            self.speed = rate;
            self.speeds.push(rate);
        }
    }

    fn duration(&self) -> f64 {
        self.dur
    }

    fn play_preview(&mut self, _wav: Vec<u8>) -> Result<(), String> {
        if let Some(err) = &self.fail_with {
            return Err(err.clone());
        }
        self.previews += 1;
        Ok(())
    }
}

fn example_index(ex: SnapExample) -> usize {
    match ex {
        SnapExample::Plate => 0,
        SnapExample::Brick => 1,
        SnapExample::Pin => 2,
    }
}

/// Manages the live transport snap track and the Snap Sound page's sample previews.
pub struct SnapSound<S: Sink = RodioSink> {
    pub sink: S,
    track_key: Option<(u64, u64, u64)>,
    warned_audio: bool,
    pub last_example: Option<SnapExample>,
    pub waveforms: [Option<Vec<f32>>; 3],
    preview_rx: Option<mpsc::Receiver<(SnapExample, Option<Vec<u8>>)>>,
}

impl<S: Sink + Default> Default for SnapSound<S> {
    fn default() -> Self {
        Self::new(S::default())
    }
}

impl<S: Sink> SnapSound<S> {
    pub fn new(sink: S) -> Self {
        Self {
            sink,
            track_key: None,
            warned_audio: false,
            last_example: None,
            waveforms: [None, None, None],
            preview_rx: None,
        }
    }

    fn audio_notice(&mut self, err: String) -> Option<Notice> {
        if self.warned_audio {
            return None;
        }
        self.warned_audio = true;
        Some(Notice::Warning { title: "Couldn't play snap sound".into(), detail: err })
    }

    /// Synchronises the snap audio track with the transport, regenerating the WAV only when the
    /// document, plan version, or session version changes.
    pub fn follow(
        &mut self,
        session: &bm::Session,
        vp: Option<&mut bm::Viewport>,
        transport: &Transport,
        pref_enabled: bool,
        on_build_tab: bool,
        recordings: &Path,
    ) -> Option<Notice> {
        let mix_enabled = session.snap_mix().enabled;
        let audible = pref_enabled
            && mix_enabled
            && on_build_tab
            && transport.ready()
            && transport.state.playing
            && !transport.state.at_rest
            && !transport.state.stale;

        if !audible {
            self.sink.pause();
            return None;
        }

        let key = (session.generation(), transport.state.version, session.version());
        if self.track_key != Some(key) {
            let Some(vp) = vp else {
                self.sink.pause();
                return None;
            };
            let tmp = temp_wav_path("track");
            let res = vp.write_snap_track(&tmp, recordings);
            let bytes = if res.is_ok() { std::fs::read(&tmp).ok() } else { None };
            let _ = std::fs::remove_file(&tmp);
            let Some(bytes) = bytes else {
                self.sink.pause();
                return None;
            };
            match self.sink.load(bytes) {
                Ok(_) => self.track_key = Some(key),
                Err(e) => {
                    self.sink.pause();
                    return self.audio_notice(e);
                }
            }
        }

        self.sink.set_speed(transport.rate);
        let dur = self.sink.duration();
        let target = transport.time().clamp(0.0, dur.max(0.0));
        if dur <= 0.0 || target >= dur - 0.01 {
            self.sink.pause();
            return None;
        }
        if !self.sink.is_playing() || (self.sink.position() - target).abs() > 0.08 {
            self.sink.seek(target);
        }
        if !self.sink.is_playing()
            && let Err(e) = self.sink.play()
        {
            return self.audio_notice(e);
        }
        None
    }

    /// Renders a sample snap WAV on a worker thread (no plan needed) and plays it when ready.
    pub fn request_sample(&mut self, mix: SnapMix, example: SnapExample, recordings: PathBuf) {
        self.last_example = Some(example);
        let (tx, rx) = mpsc::channel();
        self.preview_rx = Some(rx);
        let _ = std::thread::Builder::new().name("bm-sound".into()).spawn(move || {
            let tmp = temp_wav_path("preview");
            let ok = bm::settings::write_snap_preview(&mix, example, &recordings, &tmp);
            let bytes = if ok { std::fs::read(&tmp).ok() } else { None };
            let _ = std::fs::remove_file(&tmp);
            let _ = tx.send((example, bytes));
        });
    }

    /// Polls for a finished sample preview, stores its waveform, and plays it.
    pub fn poll_preview(&mut self) -> Option<Notice> {
        let rx = self.preview_rx.as_ref()?;
        match rx.try_recv() {
            Ok((ex, bytes)) => {
                self.preview_rx = None;
                if let Some(wav) = bytes {
                    self.waveforms[example_index(ex)] = Some(wav_peaks(&wav, 36));
                    if let Err(e) = self.sink.play_preview(wav) {
                        return self.audio_notice(e);
                    }
                }
                None
            }
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => {
                self.preview_rx = None;
                None
            }
        }
    }

    pub fn preview_pending(&self) -> bool {
        self.preview_rx.is_some()
    }

    pub fn waveform(&self, ex: SnapExample) -> Option<&[f32]> {
        self.waveforms[example_index(ex)].as_deref()
    }

    pub fn pause(&mut self) {
        self.sink.pause();
    }

    pub fn reset(&mut self) {
        self.sink.pause();
        self.track_key = None;
    }
}
