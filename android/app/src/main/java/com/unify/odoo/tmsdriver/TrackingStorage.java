package com.unify.odoo.tmsdriver;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;

public final class TrackingStorage {

    private static final String PREFS = "tms_background_tracking";
    private static final String KEY_ACTIVE = "active";
    private static final String KEY_BASE_URL = "base_url";
    private static final String KEY_TRIP_TOKEN = "trip_token";
    private static final String KEY_INTERVAL_MS = "interval_ms";
    private static final String KEY_DISTANCE_METERS = "distance_meters";
    private static final String KEY_HEARTBEAT_MS = "heartbeat_ms";
    private static final String KEY_QUEUE = "queue_json";

    private TrackingStorage() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void saveConfig(Context context, String baseUrl, String tripToken, int intervalMs, int distanceMeters, int heartbeatMs) {
        prefs(context).edit()
            .putString(KEY_BASE_URL, baseUrl)
            .putString(KEY_TRIP_TOKEN, tripToken)
            .putInt(KEY_INTERVAL_MS, Math.max(intervalMs, 10000))
            .putInt(KEY_DISTANCE_METERS, Math.max(distanceMeters, 5))
            .putInt(KEY_HEARTBEAT_MS, Math.max(heartbeatMs, 60000))
            .apply();
    }

    public static boolean isActive(Context context) {
        return prefs(context).getBoolean(KEY_ACTIVE, false);
    }

    public static void setActive(Context context, boolean active) {
        prefs(context).edit().putBoolean(KEY_ACTIVE, active).apply();
    }

    public static String getBaseUrl(Context context) {
        return prefs(context).getString(KEY_BASE_URL, "");
    }

    public static String getTripToken(Context context) {
        return prefs(context).getString(KEY_TRIP_TOKEN, "");
    }

    public static int getIntervalMs(Context context) {
        return prefs(context).getInt(KEY_INTERVAL_MS, 15000);
    }

    public static int getDistanceMeters(Context context) {
        return prefs(context).getInt(KEY_DISTANCE_METERS, 25);
    }

    public static int getHeartbeatMs(Context context) {
        return prefs(context).getInt(KEY_HEARTBEAT_MS, 60000);
    }

    public static JSONArray getQueue(Context context) {
        String raw = prefs(context).getString(KEY_QUEUE, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    public static void setQueue(Context context, JSONArray queue) {
        prefs(context).edit().putString(KEY_QUEUE, queue.toString()).apply();
    }

    public static int getQueueCount(Context context) {
        return getQueue(context).length();
    }
}
