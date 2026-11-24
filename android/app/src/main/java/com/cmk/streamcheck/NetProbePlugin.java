package com.cmk.streamcheck;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android native layer for Stream Check (the Windows twin is desktop/native.go):
 * TCP ping, speed test, Keystore-encrypted storage, and opening links.
 * Plain HTTP requests go through Capacitor's built-in CapacitorHttp plugin.
 */
@CapacitorPlugin(name = "NetProbe")
public class NetProbePlugin extends Plugin {
    private static final String KEY_ALIAS = "streamcheck_secrets";
    private static final String PREFS = "streamcheck_secure";
    private static final String UA = "StreamCheck/1.4 (Android)";
    private final ExecutorService pool = Executors.newFixedThreadPool(10);

    // ------------------------------------------------------------ TCP ping
    @PluginMethod
    public void tcpPing(PluginCall call) {
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 443);
        final int timeout = call.getInt("timeout", 3000);
        pool.execute(() -> {
            long t0 = System.nanoTime();
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(host, port), timeout);
                long ms = Math.max(1, (System.nanoTime() - t0) / 1_000_000);
                JSObject r = new JSObject();
                r.put("ms", ms);
                r.put("error", "");
                call.resolve(r);
            } catch (Exception e) {
                JSObject r = new JSObject();
                r.put("ms", -1);
                r.put("error", friendly(e));
                call.resolve(r);
            }
        });
    }

    // ------------------------------------------------------------ speed test
    @PluginMethod
    public void speedTest(PluginCall call) {
        final String id = call.getString("id", "");
        final String url = call.getString("url", "");
        final int seconds = call.getInt("seconds", 8);
        pool.execute(() -> {
            JSObject res = new JSObject();
            res.put("id", id);
            HttpURLConnection c = null;
            try {
                if (!url.startsWith("https://") && !url.startsWith("http://")) throw new IllegalArgumentException("bad URL");
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(10000);
                c.setRequestProperty("User-Agent", UA);
                int code = c.getResponseCode();
                if (code >= 400) throw new Exception("HTTP " + code);
                byte[] buf = new byte[256 * 1024];
                long total = 0;
                long start = System.nanoTime(), last = start, limit = seconds * 1_000_000_000L;
                try (InputStream in = c.getInputStream()) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        long now = System.nanoTime();
                        if (now - last > 250_000_000L) {
                            last = now;
                            JSObject p = new JSObject();
                            p.put("id", id);
                            p.put("mbps", total * 8 / ((now - start) / 1e9) / 1e6);
                            p.put("mb", total / 1e6);
                            notifyListeners("speed", p);
                        }
                        if (now - start > limit) break;
                    }
                }
                double el = (System.nanoTime() - start) / 1e9;
                res.put("mbps", el > 0 ? total * 8 / el / 1e6 : 0);
                res.put("mb", total / 1e6);
                res.put("error", "");
            } catch (Exception e) {
                res.put("mbps", 0);
                res.put("mb", 0);
                res.put("error", friendly(e));
            } finally {
                if (c != null) c.disconnect();
            }
            call.resolve(res);
        });
    }

    // ------------------------------------------------------------ encrypted storage
    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = call.getString("key", "");
        String stored = prefs().getString(key, null);
        JSObject r = new JSObject();
        r.put("value", "");
        if (stored != null) {
            try {
                byte[] all = Base64.decode(stored, Base64.NO_WRAP);
                ByteBuffer bb = ByteBuffer.wrap(all);
                byte[] iv = new byte[12];
                bb.get(iv);
                byte[] ct = new byte[bb.remaining()];
                bb.get(ct);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
                r.put("value", new String(cipher.doFinal(ct), StandardCharsets.UTF_8));
            } catch (Exception e) {
                prefs().edit().remove(key).apply(); // undecryptable (e.g. key reset) → forget it
            }
        }
        call.resolve(r);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        try {
            if (value == null || value.isEmpty()) {
                prefs().edit().remove(key).apply();
            } else {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, secretKey());
                byte[] iv = cipher.getIV();
                byte[] ct = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
                byte[] all = ByteBuffer.allocate(iv.length + ct.length).put(iv).put(ct).array();
                prefs().edit().putString(key, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("could not save securely: " + e.getMessage());
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    // ------------------------------------------------------------ device name (shown in the PC's "Allow this phone?" prompt)
    @PluginMethod
    public void deviceName(PluginCall call) {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "Android phone" : Build.MODEL;
        String name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : (maker.isEmpty() ? model : capitalize(maker) + " " + model);
        JSObject r = new JSObject();
        r.put("name", name);
        call.resolve(r);
    }

    private static String capitalize(String s) {
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    // ------------------------------------------------------------ links
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url.startsWith("https://") || url.startsWith("http://")) {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    private static String friendly(Exception e) {
        String s = e.getClass().getSimpleName() + ": " + e.getMessage();
        if (s.contains("UnknownHost")) return "domain not found (DNS)";
        if (s.contains("Timeout") || s.contains("timed out")) return "timed out";
        if (s.contains("refused")) return "connection refused";
        if (s.contains("reset")) return "connection reset";
        if (s.contains("SSL") || s.contains("Certificate")) return "secure connection failed (TLS)";
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }
}
