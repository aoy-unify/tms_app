package com.unify.odoo.tmsdriver;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BackgroundTracking",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "background", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION })
    }
)
public class BackgroundTrackingPlugin extends Plugin {

    @PluginMethod
    public void getTrackingState(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", TrackingStorage.isActive(getContext()));
        result.put("baseUrl", TrackingStorage.getBaseUrl(getContext()));
        result.put("tripToken", TrackingStorage.getTripToken(getContext()));
        result.put("intervalMs", TrackingStorage.getIntervalMs(getContext()));
        result.put("distanceMeters", TrackingStorage.getDistanceMeters(getContext()));
        result.put("heartbeatMs", TrackingStorage.getHeartbeatMs(getContext()));
        result.put("queuedCount", TrackingStorage.getQueueCount(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void requestTrackingPermissions(PluginCall call) {
        requestAllPermissions(call, "onPermissionsResult");
    }

    @PluginMethod
    public void startTracking(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "").trim();
        String tripToken = call.getString("tripToken", "").trim();
        int intervalMs = call.getInt("intervalMs", 15000);
        int distanceMeters = call.getInt("distanceMeters", 25);
        int heartbeatMs = call.getInt("heartbeatMs", 60000);

        if (baseUrl.isEmpty() || tripToken.isEmpty()) {
            call.reject("baseUrl and tripToken are required");
            return;
        }

        PermissionState locationState = getPermissionState("location");
        PermissionState backgroundState = getPermissionState("background");
        if (locationState != PermissionState.GRANTED || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && backgroundState != PermissionState.GRANTED)) {
            call.reject("Location permissions are not granted");
            return;
        }

        TrackingStorage.saveConfig(getContext(), baseUrl, tripToken, intervalMs, distanceMeters, heartbeatMs);
        TrackingStorage.setActive(getContext(), true);

        Intent intent = TrackingForegroundService.buildStartIntent(
            getContext(),
            baseUrl,
            tripToken,
            intervalMs,
            distanceMeters,
            heartbeatMs
        );
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve(new JSObject().put("active", true));
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        TrackingStorage.setActive(getContext(), false);
        Intent stopIntent = TrackingForegroundService.buildStopIntent(getContext());
        getContext().startService(stopIntent);
        call.resolve(new JSObject().put("active", false));
    }

    @PluginMethod
    public void resumeTrackingIfActive(PluginCall call) {
        if (!TrackingStorage.isActive(getContext())) {
            call.resolve(new JSObject().put("resumed", false));
            return;
        }

        String baseUrl = TrackingStorage.getBaseUrl(getContext());
        String tripToken = TrackingStorage.getTripToken(getContext());
        int intervalMs = TrackingStorage.getIntervalMs(getContext());
        int distanceMeters = TrackingStorage.getDistanceMeters(getContext());
        int heartbeatMs = TrackingStorage.getHeartbeatMs(getContext());
        if (baseUrl.isEmpty() || tripToken.isEmpty()) {
            TrackingStorage.setActive(getContext(), false);
            call.resolve(new JSObject().put("resumed", false));
            return;
        }

        Intent intent = TrackingForegroundService.buildStartIntent(
            getContext(),
            baseUrl,
            tripToken,
            intervalMs,
            distanceMeters,
            heartbeatMs
        );
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve(new JSObject().put("resumed", true));
    }

    @PluginMethod
    public void flushQueue(PluginCall call) {
        Intent intent = TrackingForegroundService.buildFlushIntent(getContext());
        getContext().startService(intent);
        call.resolve(new JSObject().put("queuedCount", TrackingStorage.getQueueCount(getContext())));
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception ex) {
            call.reject("Cannot open settings", ex);
        }
    }

    @PermissionCallback
    private void onPermissionsResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("location", getPermissionState("location").toString().toLowerCase());
        result.put("background", getPermissionState("background").toString().toLowerCase());
        call.resolve(result);
    }
}
