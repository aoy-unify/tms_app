import { SplashScreen } from '@capacitor/splash-screen';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import { Clipboard } from '@capacitor/clipboard';
import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';

const STORAGE_BASE_URL = 'odoo_base_url';
const STORAGE_TRACKING_ACTIVE = 'tracking_active';
const STORAGE_AUTO_TRACKING = 'auto_tracking_enabled';
const TRACKING_INTERVAL_MS = 15_000;
const TRACKING_DISTANCE_METERS = 25;
const TRACKING_HEARTBEAT_MS = 60_000;
const BackgroundTracking = registerPlugin('BackgroundTracking');

function normalizeUrl(raw) {
  const t = raw.trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) {
    return `https://${t}`;
  }
  return t;
}

function normalizeHttpsUrl(raw) {
  const normalized = normalizeUrl(raw);
  if (!normalized) {
    return '';
  }
  if (!/^https:\/\//i.test(normalized)) {
    return '';
  }
  return normalized;
}

function parseTripContextFromUrl(tripUrl) {
  try {
    const u = new URL(tripUrl);
    const match = u.pathname.match(/\/tms\/trip\/([^/]+)/i);
    if (!match || !match[1]) {
      return null;
    }
    return {
      baseUrl: u.origin,
      tripToken: match[1],
    };
  } catch (error) {
    return null;
  }
}

async function loadSavedUrl() {
  const { value } = await Preferences.get({ key: STORAGE_BASE_URL });
  return value || '';
}

async function saveUrl(url) {
  await Preferences.set({ key: STORAGE_BASE_URL, value: url });
}

async function setTrackingActive(active) {
  await Preferences.set({ key: STORAGE_TRACKING_ACTIVE, value: active ? '1' : '0' });
}

async function isTrackingActiveStored() {
  const { value } = await Preferences.get({ key: STORAGE_TRACKING_ACTIVE });
  return value === '1';
}

async function setAutoTrackingEnabled(enabled) {
  await Preferences.set({ key: STORAGE_AUTO_TRACKING, value: enabled ? '1' : '0' });
}

async function isAutoTrackingEnabled() {
  const { value } = await Preferences.get({ key: STORAGE_AUTO_TRACKING });
  return value === '1';
}

async function ensureLocationPermission() {
  const perm = await Geolocation.checkPermissions();
  if (perm.location === 'granted' || perm.coarseLocation === 'granted') {
    return true;
  }
  const req = await Geolocation.requestPermissions();
  return req.location === 'granted' || req.coarseLocation === 'granted';
}

async function requestBackgroundPermission() {
  if (Capacitor.getPlatform() !== 'android') {
    return true;
  }
  try {
    const result = await BackgroundTracking.requestTrackingPermissions();
    return result.location === 'granted' && result.background === 'granted';
  } catch (error) {
    console.warn('requestTrackingPermissions failed', error);
    return false;
  }
}

async function requestAllLocationPermissionsOnAppEnter(setStatus) {
  if (Capacitor.getPlatform() !== 'android') {
    return;
  }

  const foregroundGranted = await ensureLocationPermission();
  if (!foregroundGranted) {
    setStatus('ยังไม่ได้รับสิทธิ์ตำแหน่ง กรุณากดอนุญาตเพื่อใช้งาน GPS', 'err');
    return;
  }

  const backgroundGranted = await requestBackgroundPermission();
  if (!backgroundGranted) {
    setStatus('ยังไม่ได้เปิดสิทธิ์ตำแหน่งพื้นหลัง กรุณาเปิดเป็น "อนุญาตตลอดเวลา" ใน Android Settings', 'warn');
    try {
      await BackgroundTracking.openLocationSettings();
    } catch (error) {
      console.warn('openLocationSettings failed', error);
    }
  }
}

class TmsDriverApp extends HTMLElement {
  constructor() {
    super();
    SplashScreen.hide();

    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host {
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Thai", sans-serif;
          display: block;
          min-height: 100vh;
          box-sizing: border-box;
          background: #f4f2fb;
          color: #1a1240;
        }
        *, *::before, *::after { box-sizing: border-box; }
        header {
          background: linear-gradient(135deg, #6b3fa0, #7f56d9);
          color: #fff;
          padding: 28px 20px 32px;
          border-radius: 0 0 24px 24px;
        }
        header h1 {
          margin: 0 0 4px;
          font-size: 1.35rem;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        header p {
          margin: 0;
          font-size: 0.88rem;
          opacity: 0.9;
        }
        main {
          padding: 0 16px 24px;
          margin-top: -16px;
        }
        .status-card {
          display: flex;
          align-items: center;
          gap: 14px;
          background: #fff;
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 16px;
          box-shadow: 0 2px 12px rgba(20, 8, 47, 0.08);
        }
        .status-icon {
          flex-shrink: 0;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .status-card.active .status-icon {
          background: #ecfdf3;
          color: #12b76a;
        }
        .status-card.inactive .status-icon {
          background: #f2f4f7;
          color: #98a2b3;
        }
        .status-card.warn .status-icon {
          background: #fffaeb;
          color: #f79009;
        }
        .status-card.err .status-icon {
          background: #fef3f2;
          color: #f04438;
        }
        .status-card.active .status-title { color: #12b76a; }
        .status-card.inactive .status-title { color: #344054; }
        .status-card.warn .status-title { color: #b54708; }
        .status-card.err .status-title { color: #b42318; }
        .status-title {
          margin: 0 0 2px;
          font-size: 1rem;
          font-weight: 600;
        }
        .status-subtitle {
          margin: 0;
          font-size: 0.82rem;
          color: #667085;
        }
        .field-label {
          display: block;
          font-size: 0.9rem;
          font-weight: 600;
          margin-bottom: 8px;
          color: #344054;
        }
        .input-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
          background: #fff;
          border: 1.5px solid #e4e7ec;
          border-radius: 12px;
          padding: 0 14px;
          margin-bottom: 16px;
          box-shadow: 0 1px 4px rgba(20, 8, 47, 0.04);
        }
        .input-wrap:focus-within {
          border-color: #7f56d9;
          box-shadow: 0 0 0 3px rgba(127, 86, 217, 0.12);
        }
        .input-icon {
          flex-shrink: 0;
          color: #7f56d9;
          display: flex;
        }
        input[type="url"] {
          flex: 1;
          min-width: 0;
          border: 0;
          background: transparent;
          padding: 14px 0;
          font-size: 0.92rem;
          color: #1a1240;
          outline: none;
        }
        input[type="url"]::placeholder { color: #98a2b3; }
        .btn-primary {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          width: 100%;
          border: 0;
          border-radius: 14px;
          padding: 16px 20px;
          font-size: 1.05rem;
          font-weight: 700;
          cursor: pointer;
          background: linear-gradient(135deg, #6b3fa0, #7f56d9);
          color: #fff;
          box-shadow: 0 4px 14px rgba(107, 63, 160, 0.35);
          margin-bottom: 16px;
        }
        .btn-primary:active { opacity: 0.92; transform: scale(0.99); }
        .btn-primary .arrow { margin-left: auto; }
        .toggle-card {
          display: block;
          background: #fff;
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 16px;
          box-shadow: 0 2px 12px rgba(20, 8, 47, 0.08);
          cursor: pointer;
        }
        .toggle-row {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .toggle-switch {
          position: relative;
          flex-shrink: 0;
          width: 52px;
          height: 30px;
        }
        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
          position: absolute;
        }
        .toggle-slider {
          position: absolute;
          inset: 0;
          background: #e4e7ec;
          border-radius: 30px;
          transition: background 0.2s;
        }
        .toggle-slider::before {
          content: "";
          position: absolute;
          width: 24px;
          height: 24px;
          left: 3px;
          bottom: 3px;
          background: #fff;
          border-radius: 50%;
          transition: transform 0.2s;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        }
        .toggle-switch input:checked + .toggle-slider {
          background: #12b76a;
        }
        .toggle-switch input:checked + .toggle-slider::before {
          transform: translateX(22px);
        }
        .toggle-label {
          display: block;
          font-size: 0.95rem;
          font-weight: 600;
          color: #344054;
        }
        .toggle-hint {
          display: block;
          font-size: 0.8rem;
          color: #667085;
          margin-top: 2px;
        }
        .btn-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 20px;
        }
        .btn-outline {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border: 2px solid #7f56d9;
          border-radius: 14px;
          padding: 16px 10px;
          font-size: 0.88rem;
          font-weight: 600;
          cursor: pointer;
          background: #fff;
          color: #5b2d8b;
          min-height: 88px;
        }
        .btn-outline:active { background: #f9f5ff; }
        .btn-outline svg { color: #7f56d9; }
        .toast {
          font-size: 0.82rem;
          text-align: center;
          padding: 10px 14px;
          border-radius: 10px;
          margin-bottom: 12px;
          background: #fff;
          box-shadow: 0 1px 6px rgba(20, 8, 47, 0.06);
        }
        .toast[hidden] { display: none; }
        .toast.ok { color: #027a48; background: #ecfdf3; }
        .toast.err { color: #b42318; background: #fef3f2; }
        .toast.warn { color: #b54708; background: #fffaeb; }
        .hint {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          font-size: 0.82rem;
          color: #475467;
          line-height: 1.5;
          padding: 14px 16px;
          background: #f9f5ff;
          border-radius: 12px;
          border-left: 4px solid #7f56d9;
        }
        .hint-icon {
          flex-shrink: 0;
          color: #7f56d9;
          margin-top: 1px;
        }
      </style>
      <header>
        <h1>Odoo TMS Driver</h1>
        <p>แอปสำหรับคนขับรถ</p>
      </header>
      <main>
        <div class="status-card inactive" id="tracking-card">
          <div class="status-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
          </div>
          <div>
            <p class="status-title" id="tracking-title">ยังไม่ติดตามตำแหน่ง</p>
            <p class="status-subtitle" id="tracking-subtitle">เปิดสวิตช์ด้านล่างเพื่อเริ่ม</p>
          </div>
        </div>

        <div class="toast" id="toast" hidden></div>

        <label class="field-label" for="url">ลิงก์ทริป</label>
        <div class="input-wrap">
          <span class="input-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </span>
          <input type="url" id="url" placeholder="https://odoo.company.com/tms/trip/..." autocomplete="off" inputmode="url" />
        </div>

        <button type="button" class="btn-primary" id="btn-open">
          <span>เปิด Odoo TMS</span>
          <span class="arrow" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          </span>
        </button>

        <label class="toggle-card" for="auto-tracking">
          <div class="toggle-row">
            <div class="toggle-switch">
              <input type="checkbox" id="auto-tracking" />
              <span class="toggle-slider"></span>
            </div>
            <div>
              <span class="toggle-label">ติดตาม GPS อัตโนมัติ</span>
              <span class="toggle-hint">ไม่ต้องกด Start/End ใน Odoo</span>
            </div>
          </div>
        </label>

        <div class="btn-row">
          <button type="button" class="btn-outline" id="btn-scan">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
              <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
              <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
              <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
              <line x1="7" y1="12" x2="17" y2="12"/>
            </svg>
            <span>แสกนบาร์โค้ด</span>
          </button>
          <button type="button" class="btn-outline" id="btn-loc">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span>ขอสิทธิ์ GPS</span>
          </button>
        </div>

        <div class="hint">
          <span class="hint-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </span>
          <span>กดย้อนกลับ 2 ครั้ง เพื่อกลับมาหน้านี้</span>
        </div>
      </main>
    `;
  }

  connectedCallback() {
    const root = this.shadowRoot;
    const urlInput = root.querySelector('#url');
    const autoTrackingInput = root.querySelector('#auto-tracking');
    const toastEl = root.querySelector('#toast');
    const trackingCard = root.querySelector('#tracking-card');
    const trackingTitle = root.querySelector('#tracking-title');
    const trackingSubtitle = root.querySelector('#tracking-subtitle');

    let toastTimer;

    const setStatus = (text, cls) => {
      if (!text) {
        toastEl.hidden = true;
        return;
      }
      clearTimeout(toastTimer);
      toastEl.hidden = false;
      toastEl.textContent = text;
      toastEl.className = 'toast' + (cls ? ` ${cls}` : '');
      toastTimer = setTimeout(() => {
        toastEl.hidden = true;
      }, 5000);
    };

    const setTrackingCard = (state, title, subtitle) => {
      trackingCard.className = `status-card ${state}`;
      trackingTitle.textContent = title;
      trackingSubtitle.textContent = subtitle;
    };

    const updateTrackingUiState = async (idleMessage = false) => {
      const active = await isTrackingActiveStored();
      if (active) {
        setTrackingCard('active', 'กำลังติดตามตำแหน่ง', 'Tracking active');
      } else if (autoTrackingInput.checked && idleMessage) {
        setTrackingCard('warn', 'รอเริ่มติดตาม', 'กรุณาใส่ลิงก์ทริป HTTPS');
      } else if (!autoTrackingInput.checked && idleMessage) {
        setTrackingCard('inactive', 'ยังไม่ติดตามตำแหน่ง', 'เปิดสวิตช์ด้านล่างเพื่อเริ่ม');
      } else {
        setTrackingCard('inactive', 'ยังไม่ติดตามตำแหน่ง', 'Tracking inactive');
      }
    };

    const startNativeTracking = async (baseUrl, tripToken) => {
      const hasForegroundPermission = await ensureLocationPermission();
      if (!hasForegroundPermission) {
        setStatus('ยังไม่ได้รับสิทธิ์ตำแหน่ง (foreground)', 'err');
        return false;
      }
      const hasBackgroundPermission = await requestBackgroundPermission();
      if (!hasBackgroundPermission) {
        setStatus('ยังไม่ได้รับสิทธิ์ตำแหน่งพื้นหลัง', 'err');
        return false;
      }
      if (Capacitor.getPlatform() === 'android') {
        await BackgroundTracking.startTracking({
          baseUrl,
          tripToken,
          intervalMs: TRACKING_INTERVAL_MS,
          distanceMeters: TRACKING_DISTANCE_METERS,
          heartbeatMs: TRACKING_HEARTBEAT_MS,
        });
      }
      await setTrackingActive(true);
      return true;
    };

    const stopNativeTracking = async () => {
      if (Capacitor.getPlatform() === 'android') {
        await BackgroundTracking.stopTracking();
      }
      await setTrackingActive(false);
    };

    const syncTrackingByAutoMode = async () => {
      const tripUrl = normalizeHttpsUrl(urlInput.value);
      const autoEnabled = autoTrackingInput.checked;
      if (!autoEnabled) {
        await stopNativeTracking();
        setStatus('ปิด Tracking อัตโนมัติแล้ว', 'warn');
        await updateTrackingUiState();
        return;
      }
      if (!tripUrl) {
        // Keep existing native tracking alive if it is already running.
        // This avoids accidental stop during startup race (URL not loaded yet).
        setStatus('เปิดโหมดอัตโนมัติแล้ว แต่ต้องใส่ลิงก์ทริปแบบ HTTPS', 'err');
        await updateTrackingUiState();
        return;
      }

      const tripContext = parseTripContextFromUrl(tripUrl);
      if (!tripContext) {
        setStatus('ลิงก์ไม่ถูกต้อง ต้องเป็นรูปแบบ /tms/trip/<token>', 'err');
        await updateTrackingUiState();
        return;
      }

      await saveUrl(tripUrl);
      const { baseUrl, tripToken } = tripContext;
      const ok = await startNativeTracking(baseUrl, tripToken);
      if (ok) {
        setStatus('Tracking อัตโนมัติทำงานแล้ว', 'ok');
      }
      await updateTrackingUiState();
    };

    const openTripUrl = async (rawUrl) => {
      const u = normalizeHttpsUrl(rawUrl);
      if (!u) {
        setStatus('กรุณาใส่ลิงก์แบบ HTTPS', 'err');
        return false;
      }
      urlInput.value = u;
      await saveUrl(u);
      if (autoTrackingInput.checked) {
        await syncTrackingByAutoMode();
      }
      setStatus('กำลังเปิด Odoo…', 'ok');
      window.location.assign(u);
      return true;
    };

    urlInput.addEventListener('blur', async () => {
      const u = normalizeHttpsUrl(urlInput.value);
      if (!u) {
        return;
      }
      await saveUrl(u);
      if (autoTrackingInput.checked) {
        await syncTrackingByAutoMode();
      }
    });

    root.querySelector('#btn-open').addEventListener('click', () => {
      openTripUrl(urlInput.value).catch((error) => console.warn(error));
    });

    root.querySelector('#btn-scan').addEventListener('click', async () => {
      try {
        const { ScanResult } = await CapacitorBarcodeScanner.scanBarcode({
          hint: CapacitorBarcodeScannerTypeHint.ALL,
          scanInstructions: 'เล็งบาร์โค้ดหรือ QR ให้อยู่ในกรอบ',
        });
        if (!ScanResult) {
          return;
        }
        const scannedUrl = normalizeHttpsUrl(ScanResult);
        if (scannedUrl) {
          await openTripUrl(ScanResult);
          return;
        }
        await Clipboard.write({ string: ScanResult });
        setStatus(`คัดลอกแล้ว: ${ScanResult}`, 'ok');
      } catch (e) {
        console.warn(e);
        setStatus('ยกเลิกการแสกนหรือเกิดข้อผิดพลาด', 'err');
      }
    });

    root.querySelector('#btn-loc').addEventListener('click', async () => {
      const ok = await ensureLocationPermission();
      setStatus(
        ok ? 'ได้รับสิทธิ์ตำแหน่งแล้ว — เปิด Odoo เพื่อให้หน้า TMS อ่าน GPS ได้' : 'ยังไม่ได้รับสิทธิ์ตำแหน่ง',
        ok ? 'ok' : 'err',
      );
    });

    autoTrackingInput.addEventListener('change', async () => {
      await setAutoTrackingEnabled(autoTrackingInput.checked);
      try {
        await syncTrackingByAutoMode();
      } catch (error) {
        console.error(error);
        setStatus('สลับโหมดอัตโนมัติไม่สำเร็จ', 'err');
      }
    });

    const resumeTrackingIfNeeded = async () => {
      const autoEnabled = await isAutoTrackingEnabled();
      autoTrackingInput.checked = autoEnabled;
      if (Capacitor.getPlatform() !== 'android') {
        await updateTrackingUiState(true);
        return;
      }
      try {
        if (autoEnabled) {
          await syncTrackingByAutoMode();
          await BackgroundTracking.resumeTrackingIfActive();
        } else {
          await stopNativeTracking();
          await updateTrackingUiState(true);
        }
      } catch (error) {
        console.warn('resumeTrackingIfActive failed', error);
        setStatus('ไม่สามารถ resume tracking อัตโนมัติได้', 'err');
      }
    };

    App.addListener('resume', () => {
      resumeTrackingIfNeeded().catch((error) => console.warn(error));
      requestAllLocationPermissionsOnAppEnter(setStatus).catch((error) => console.warn(error));
    });

    App.addListener('appUrlOpen', () => {
      /* deep links สามารถขยายได้ภายหลัง */
    });

    const initApp = async () => {
      const savedUrl = await loadSavedUrl();
      if (savedUrl) {
        urlInput.value = savedUrl;
      }
      await requestAllLocationPermissionsOnAppEnter(setStatus);
      await resumeTrackingIfNeeded();
    };

    initApp().catch((error) => console.warn(error));
  }
}

window.customElements.define('tms-driver-app', TmsDriverApp);
