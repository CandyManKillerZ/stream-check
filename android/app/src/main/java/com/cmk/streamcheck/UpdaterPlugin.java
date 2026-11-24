package com.cmk.streamcheck;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Native in-app updater for the Android build (ported from ElderKeep, same guards).
 *
 * Downloads the latest APK with Android's DownloadManager (into the app's own
 * external files dir — no storage permission required) and, on completion,
 * launches the system package installer via a FileProvider URI.
 *
 * This replaces the old "open the APK link in an in-app browser" approach, which
 * could not run the download + "install unknown app" handoff and simply hung.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final String APK_NAME = "StreamCheck-update.apk";

    private long downloadId = -1L;
    private BroadcastReceiver receiver;

    /** In-flight download guard. A second tap while a download runs must not start a
     *  concurrent copy, and a relaunch after a completed download must not re-fetch the
     *  same ~17 MB APK. Repeated downloads from one IP trip GitHub's abuse rate limit,
     *  which then also blocks the desktop client on the same network (shared public IP). */
    private boolean downloading = false;
    private String  downloadingVersion = null;

    /**
     * Set when the APK is downloaded but "install unknown apps" is not granted yet.
     * We send the user to the system settings screen and retry the install when they
     * come back — without this the download completes and then nothing ever happens,
     * which looks exactly like the app being stuck on "Downloading update…".
     */
    private boolean installPending = false;

    /** Tells the banner what went wrong so it can stop showing "Downloading…" forever. */
    private void fail(String reason) {
        JSObject ev = new JSObject();
        ev.put("reason", reason);
        notifyListeners("updateError", ev, true);
    }

    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String url = call.getString("url");
        final String version = call.getString("version"); // target version, for dedupe
        if (url == null || url.isEmpty()) {
            call.reject("No download url provided");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                final Context ctx = getContext();
                File apk = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME);

                // Dedupe 1 — the correct APK is already on disk. This survives an app restart
                // (the file persists even though our in-memory state does not), so re-tapping
                // the banner or relaunching installs the existing file instead of pulling
                // another ~17 MB. We read the APK's own versionName so this is trustworthy
                // across process death, with no persisted state to go stale.
                if (version != null && apk.exists() && version.equals(apkVersionName(ctx, apk))) {
                    installApk(ctx);
                    call.resolve();
                    return;
                }

                // Dedupe 2 — a download for this version is already running; a second tap must
                // not enqueue a concurrent copy.
                if (downloading && version != null && version.equals(downloadingVersion)) {
                    call.resolve();
                    return;
                }

                // Stale or wrong-version file — remove before fetching the right one.
                if (apk.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    apk.delete();
                }

                ensureReceiver(ctx);

                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle("Stream Check update");
                req.setDescription("Downloading the latest version…");
                req.setMimeType("application/vnd.android.package-archive");
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, APK_NAME);

                DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) {
                    call.reject("DownloadManager unavailable");
                    return;
                }
                downloadId = dm.enqueue(req);
                downloading = true;
                downloadingVersion = version;
                call.resolve();
            } catch (Exception e) {
                downloading = false;
                call.reject("Update download failed: " + e.getMessage());
            }
        });
    }

    /** versionName of an APK file on disk, or null if unreadable. Lets us tell whether the
     *  already-downloaded APK is the one we are about to fetch, without persisting any state. */
    private String apkVersionName(Context ctx, File apk) {
        try {
            android.content.pm.PackageInfo pi =
                ctx.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
            return pi != null ? pi.versionName : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Registers the download-complete receiver once (system broadcast → RECEIVER_EXPORTED). */
    private void ensureReceiver(Context ctx) {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != downloadId) return;
                downloading = false; // reached a terminal state (success or failure)
                // ACTION_DOWNLOAD_COMPLETE also fires for FAILED downloads — check the
                // status before assuming there is an APK on disk to install.
                if (!downloadSucceeded(c.getApplicationContext(), id)) {
                    fail("download");
                    return;
                }
                installApk(c.getApplicationContext());
            }
        };
        ContextCompat.registerReceiver(
            ctx.getApplicationContext(),
            receiver,
            new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        );
    }

    /** True only if the download manager reports the download as successful. */
    private boolean downloadSucceeded(Context ctx, long id) {
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return false;
        Cursor cur = null;
        try {
            cur = dm.query(new DownloadManager.Query().setFilterById(id));
            if (cur == null || !cur.moveToFirst()) return false;
            int col = cur.getColumnIndex(DownloadManager.COLUMN_STATUS);
            return col >= 0 && cur.getInt(col) == DownloadManager.STATUS_SUCCESSFUL;
        } catch (Exception e) {
            return false;
        } finally {
            if (cur != null) cur.close();
        }
    }

    /**
     * Launches the system installer for the freshly downloaded APK.
     *
     * On Android 8+ the REQUEST_INSTALL_PACKAGES manifest entry is NOT enough — the
     * user must also grant "install unknown apps" for Stream Check specifically. Without
     * that grant the installer intent is refused and, because the old code swallowed
     * every exception, the update silently did nothing. Route the user to the grant
     * screen instead and finish the install when they return (see handleOnResume).
     */
    private void installApk(Context ctx) {
        File apk = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME);
        if (!apk.exists()) {
            fail("missing");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !ctx.getPackageManager().canRequestPackageInstalls()) {
            installPending = true;
            fail("permission");
            try {
                Intent grant = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + ctx.getPackageName())
                );
                grant.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(grant);
            } catch (Exception ignored) {
                // Some OEM builds hide that screen — the banner's error state tells the
                // user to enable it manually.
            }
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(intent);
            installPending = false;
        } catch (Exception e) {
            installPending = false;
            fail("installer");
        }
    }

    /** Finishes an install that was blocked on the "install unknown apps" grant. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!installPending) return;
        Context ctx = getContext().getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !ctx.getPackageManager().canRequestPackageInstalls()) {
            return; // still not granted — leave the banner in its error state
        }
        installPending = false;
        installApk(ctx);
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try {
                getContext().getApplicationContext().unregisterReceiver(receiver);
            } catch (Exception ignored) {
            }
            receiver = null;
        }
        super.handleOnDestroy();
    }
}
