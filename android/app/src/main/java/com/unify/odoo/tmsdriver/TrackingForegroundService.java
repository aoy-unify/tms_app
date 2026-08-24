package com.unify.odoo.tmsdriver;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

public class TrackingForegroundService extends Service {

    private static final String CHANNEL_ID = "tms_tracking_channel";
    private static final int NOTIFICATION_ID = 1107;
    private static final String ACTION_START = "com.unify.odoo.tmsdriver.action.START_TRACKING";
    private static final String ACTION_STOP = "com.unify.odoo.tmsdriver.action.STOP_TRACKING";
    private static final String ACTION_FLUSH = "com.unify.odoo.tmsdriver.action.FLUSH_QUEUE";
    private static final String EXTRA_BASE_URL = "extra_base_url";
    private static final String EXTRA_TRIP_TOKEN = "extra_trip_token";
    private static final String EXTRA_INTERVAL_MS = "extra_interval_ms";
    private static final String EXTRA_DISTANCE_METERS = "extra_distance_meters";
    private static final String EXTRA_HEARTBEAT_MS = "extra_heartbeat_ms";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private Runnable heartbeatRunnable;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    private volatile String baseUrl = "";
    private volatile String tripToken = "";
    private volatile int intervalMs = 15000;
    private volatile int distanceMeters = 25;
    private volatile int heartbeatMs = 60000;
    private volatile long lastSentAt = 0L;
    private volatile Location lastKnownLocation;

    public static Intent buildStartIntent(
        Context context,
        String baseUrl,
        String tripToken,
        int intervalMs,
        int distanceMeters,
        int heartbeatMs
    ) {
        Intent intent = new Intent(context, TrackingForegroundService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_BASE_URL, baseUrl);
        intent.putExtra(EXTRA_TRIP_TOKEN, tripToken);
        intent.putExtra(EXTRA_INTERVAL_MS, intervalMs);
        intent.putExtra(EXTRA_DISTANCE_METERS, distanceMeters);
        intent.putExtra(EXTRA_HEARTBEAT_MS, heartbeatMs);
        return intent;
    }

    public static Intent buildStopIntent(Context context) {
        Intent intent = new Intent(context, TrackingForegroundService.class);
        intent.setAction(ACTION_STOP);
        return intent;
    }

    public static Intent buildFlushIntent(Context context) {
        Intent intent = new Intent(context, TrackingForegroundService.class);
        intent.setAction(ACTION_FLUSH);
        return intent;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopTrackingInternal();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_FLUSH.equals(action)) {
            flushQueueAsync();
            return START_STICKY;
        }

        if (intent != null && ACTION_START.equals(action)) {
            baseUrl = normalizeBaseUrl(intent.getStringExtra(EXTRA_BASE_URL));
            tripToken = safeString(intent.getStringExtra(EXTRA_TRIP_TOKEN));
            intervalMs = Math.max(intent.getIntExtra(EXTRA_INTERVAL_MS, 15000), 10000);
            distanceMeters = Math.max(intent.getIntExtra(EXTRA_DISTANCE_METERS, 25), 5);
            heartbeatMs = Math.max(intent.getIntExtra(EXTRA_HEARTBEAT_MS, 60000), 60000);
            TrackingStorage.saveConfig(this, baseUrl, tripToken, intervalMs, distanceMeters, heartbeatMs);
            TrackingStorage.setActive(this, true);
        } else {
            baseUrl = normalizeBaseUrl(TrackingStorage.getBaseUrl(this));
            tripToken = TrackingStorage.getTripToken(this);
            intervalMs = TrackingStorage.getIntervalMs(this);
            distanceMeters = TrackingStorage.getDistanceMeters(this);
            heartbeatMs = TrackingStorage.getHeartbeatMs(this);
        }

        if (baseUrl.isEmpty() || tripToken.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification("Tracking trip location..."));
        startTrackingInternal();
        return START_STICKY;
    }

    private void startTrackingInternal() {
        if (!hasLocationPermission()) {
            updateNotification("Location permission is missing");
            return;
        }

        LocationRequest locationRequest = new LocationRequest.Builder(intervalMs)
            .setMinUpdateDistanceMeters(distanceMeters)
            .setWaitForAccurateLocation(false)
            .setPriority(LocationRequest.PRIORITY_BALANCED_POWER_ACCURACY)
            .build();

        if (locationCallback != null) {
            fusedClient.removeLocationUpdates(locationCallback);
        }

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                Location latest = result.getLastLocation();
                if (latest == null) {
                    return;
                }
                lastKnownLocation = latest;
                long now = System.currentTimeMillis();
                if (now - lastSentAt >= intervalMs) {
                    sendWithQueueAsync(latest, "background");
                }
            }
        };

        fusedClient.requestLocationUpdates(locationRequest, locationCallback, Looper.getMainLooper());
        // Try to send an initial point quickly (even before movement callbacks).
        requestAndSendCurrentLocation("startup");
        scheduleHeartbeat();
        registerNetworkCallback();
    }

    private void stopTrackingInternal() {
        TrackingStorage.setActive(this, false);
        if (locationCallback != null) {
            fusedClient.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
        if (heartbeatRunnable != null) {
            mainHandler.removeCallbacks(heartbeatRunnable);
            heartbeatRunnable = null;
        }
        unregisterNetworkCallback();
    }

    private void scheduleHeartbeat() {
        if (heartbeatRunnable != null) {
            mainHandler.removeCallbacks(heartbeatRunnable);
        }
        heartbeatRunnable = new Runnable() {
            @Override
            public void run() {
                if (!TrackingStorage.isActive(TrackingForegroundService.this)) {
                    return;
                }
                long now = System.currentTimeMillis();
                if (lastKnownLocation != null && now - lastSentAt >= heartbeatMs) {
                    sendWithQueueAsync(lastKnownLocation, "background");
                } else {
                    // Force-refresh location snapshot to keep points flowing while stationary/screen-off.
                    requestAndSendCurrentLocation("heartbeat");
                    flushQueueAsync();
                }
                mainHandler.postDelayed(this, heartbeatMs);
            }
        };
        mainHandler.postDelayed(heartbeatRunnable, heartbeatMs);
    }

    private void requestAndSendCurrentLocation(String reason) {
        if (!hasLocationPermission()) {
            return;
        }
        fusedClient.getLastLocation().addOnSuccessListener(location -> {
            if (location == null) {
                return;
            }
            lastKnownLocation = location;
            long now = System.currentTimeMillis();
            if (now - lastSentAt >= intervalMs) {
                sendWithQueueAsync(location, reason);
            }
        });
    }

    private void sendWithQueueAsync(Location location, String reason) {
        JSONObject item = new JSONObject();
        try {
            item.put("latitude", location.getLatitude());
            item.put("longitude", location.getLongitude());
            item.put("accuracy", location.getAccuracy());
            item.put("reason", reason);
            item.put("ts", System.currentTimeMillis());
        } catch (Exception ignored) {
            return;
        }

        new Thread(() -> {
            boolean sent = postToOdoo(item);
            if (!sent) {
                enqueue(item);
                updateNotification("Offline/failed send. Queued: " + TrackingStorage.getQueueCount(this));
            } else {
                lastSentAt = System.currentTimeMillis();
                flushQueueAsync();
                updateNotification("Tracking active. Last send: " + (lastSentAt / 1000L));
            }
        }).start();
    }

    private void flushQueueAsync() {
        new Thread(() -> {
            if (!isNetworkAvailable()) {
                return;
            }
            JSONArray queue = TrackingStorage.getQueue(this);
            if (queue.length() == 0) {
                return;
            }
            JSONArray remain = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject item = queue.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                if (!postToOdoo(item)) {
                    remain.put(item);
                } else {
                    lastSentAt = System.currentTimeMillis();
                }
            }
            TrackingStorage.setQueue(this, remain);
            updateNotification("Tracking active. Queue: " + remain.length());
        }).start();
    }

    private void enqueue(JSONObject item) {
        JSONArray queue = TrackingStorage.getQueue(this);
        queue.put(item);
        JSONArray trimmed = new JSONArray();
        int start = Math.max(0, queue.length() - 200);
        for (int i = start; i < queue.length(); i++) {
            trimmed.put(queue.opt(i));
        }
        TrackingStorage.setQueue(this, trimmed);
    }

    private boolean postToOdoo(JSONObject item) {
        HttpURLConnection conn = null;
        try {
            JSONObject params = new JSONObject();
            params.put("latitude", item.getDouble("latitude"));
            params.put("longitude", item.getDouble("longitude"));
            params.put("accuracy", item.getDouble("accuracy"));
            params.put("reason", "background");

            JSONObject payload = new JSONObject();
            payload.put("jsonrpc", "2.0");
            payload.put("method", "call");
            payload.put("params", params);

            String endpoint = baseUrl + "/tms/trip/" + tripToken + "/location";
            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);

            byte[] body = payload.toString().getBytes();
            OutputStream outputStream = conn.getOutputStream();
            outputStream.write(body);
            outputStream.flush();
            outputStream.close();

            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private boolean hasLocationPermission() {
        boolean fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        return fine || coarse;
    }

    private boolean isNetworkAvailable() {
        if (connectivityManager == null) {
            return false;
        }
        Network network = connectivityManager.getActiveNetwork();
        if (network == null) {
            return false;
        }
        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void registerNetworkCallback() {
        if (connectivityManager == null || networkCallback != null) {
            return;
        }
        NetworkRequest request = new NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                flushQueueAsync();
            }
        };
        connectivityManager.registerNetworkCallback(request, networkCallback);
    }

    private void unregisterNetworkCallback() {
        if (connectivityManager != null && networkCallback != null) {
            connectivityManager.unregisterNetworkCallback(networkCallback);
            networkCallback = null;
        }
    }

    private Notification buildNotification(String text) {
        Intent openAppIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (openAppIntent != null) {
            contentIntent = PendingIntent.getActivity(
                this,
                7,
                openAppIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            );
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Odoo TMS tracking is active")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }
        return builder.build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(text));
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "TMS Background Tracking",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps GPS tracking active for Odoo TMS trips");
        manager.createNotificationChannel(channel);
    }

    private static String safeString(String value) {
        return value == null ? "" : value.trim();
    }

    private static String normalizeBaseUrl(String value) {
        String url = safeString(value);
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        return url;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopTrackingInternal();
        super.onDestroy();
    }
}
