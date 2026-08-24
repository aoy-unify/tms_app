package com.unify.odoo.tmsdriver;

import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * กดปุ่มย้อนกลับสองครั้งภายใน ~2.5 วินาที ขณะอยู่ใน Odoo (ไม่ใช่ localhost ของ Capacitor)
 * เพื่อโหลดหน้าเชลล์ตั้งค่า URL / แสกนบาร์โค้ดอีกครั้ง
 */
public class MainActivity extends BridgeActivity {

    private long lastBackPressMs;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundTrackingPlugin.class);
        super.onCreate(savedInstanceState);
        lastBackPressMs = 0L;
        resumeNativeTrackingIfActive();
    }

    private void resumeNativeTrackingIfActive() {
        if (!TrackingStorage.isActive(this)) {
            return;
        }
        String baseUrl = TrackingStorage.getBaseUrl(this);
        String tripToken = TrackingStorage.getTripToken(this);
        if (baseUrl.isEmpty() || tripToken.isEmpty()) {
            TrackingStorage.setActive(this, false);
            return;
        }
        ContextCompat.startForegroundService(
            this,
            TrackingForegroundService.buildStartIntent(
                this,
                baseUrl,
                tripToken,
                TrackingStorage.getIntervalMs(this),
                TrackingStorage.getDistanceMeters(this),
                TrackingStorage.getHeartbeatMs(this)
            )
        );
    }

    private static boolean isCapacitorShellUrl(String url) {
        if (url == null) {
            return false;
        }
        Uri u = Uri.parse(url);
        String host = u.getHost();
        return "localhost".equals(host) || "127.0.0.1".equals(host);
    }

    @Override
    @Deprecated
    public void onBackPressed() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            super.onBackPressed();
            return;
        }

        String current = bridge.getWebView().getUrl();
        if (isCapacitorShellUrl(current)) {
            moveTaskToBack(true);
            return;
        }

        long now = System.currentTimeMillis();
        if (now - lastBackPressMs <= 2500L) {
            lastBackPressMs = 0L;
            String local = bridge.getLocalUrl();
            if (local != null) {
                bridge.getWebView().loadUrl(local);
            }
            Toast.makeText(this, "กลับหน้าตั้งค่าแล้ว", Toast.LENGTH_SHORT).show();
            return;
        }

        lastBackPressMs = now;
        Toast.makeText(this, "กดย้อนกลับอีกครั้งเพื่อกลับหน้าตั้งค่า", Toast.LENGTH_SHORT).show();
    }
}
