package com.nde.kodirows;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Loopback-only HLS relay. Source renews upstream signatures; Kodi's playback URL stays the same. */
final class HlsProxy implements Closeable {
    interface Source {
        /** null is the master playlist. force renews a signature after an upstream 401/403. */
        String resolve(String url, boolean force) throws IOException;
    }

    private static final Pattern URI = Pattern.compile("URI=\"([^\"]+)\"");
    private final Source source;
    private final ServerSocket server;
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final String prefix = "/" + UUID.randomUUID() + "/";
    private final Map<String, String> resources = new LinkedHashMap<String, String>(128, .75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> entry) { return size() > 4096; }
    };
    private volatile boolean closed;
    private volatile long lastRequest = System.currentTimeMillis();

    HlsProxy(Source source) throws IOException {
        this.source = source;
        server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        Thread accept = new Thread(() -> {
            while (!closed) {
                try {
                    Socket socket = server.accept();
                    workers.execute(() -> serve(socket));
                } catch (IOException | RuntimeException e) {
                    if (!closed) close();
                }
            }
        }, "kodirows-hls");
        accept.setDaemon(true);
        accept.start();
    }

    String url() { return "http://127.0.0.1:" + server.getLocalPort() + prefix + "master.m3u8"; }
    long idleMillis() { return System.currentTimeMillis() - lastRequest; }

    private String register(URL base, String ref) throws IOException {
        String target = new URL(base, ref).toString();
        URL url = new URL(target);
        if (!url.getProtocol().equals("https") && !url.getProtocol().equals("http")) throw new IOException("Unsupported HLS URL");
        String id;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(target.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 16; i++) hex.append(String.format(java.util.Locale.ROOT, "%02x", digest[i] & 255));
            id = hex.toString() + (url.getPath().endsWith(".m3u8") ? ".m3u8" : ".bin");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        synchronized (resources) { resources.put(id, target); }
        return "http://127.0.0.1:" + server.getLocalPort() + prefix + id;
    }

    private byte[] rewrite(byte[] data, URL base) throws IOException {
        StringBuilder result = new StringBuilder();
        for (String line : new String(data, StandardCharsets.UTF_8).split("\\r?\\n")) {
            if (!line.trim().isEmpty() && !line.startsWith("#")) {
                line = register(base, line.trim());
            } else {
                Matcher m = URI.matcher(line);
                StringBuffer replaced = new StringBuffer();
                while (m.find()) m.appendReplacement(replaced, Matcher.quoteReplacement("URI=\"" + register(base, m.group(1)) + "\""));
                m.appendTail(replaced);
                line = replaced.toString();
            }
            result.append(line).append('\n');
        }
        return result.toString().getBytes(StandardCharsets.UTF_8);
    }

    private void serve(Socket socket) {
        HttpURLConnection upstream = null;
        try (Socket client = socket) {
            client.setSoTimeout(15_000);
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
            String first = reader.readLine();
            if (first == null || first.length() > 4096) return;
            String[] request = first.split(" ");
            OutputStream out = client.getOutputStream();
            if (request.length != 3 || !(request[0].equals("GET") || request[0].equals("HEAD"))) {
                headers(out, 405, "text/plain", 0, null);
                return;
            }
            Map<String, String> incoming = new HashMap<>();
            int length = 0;
            for (String line; (line = reader.readLine()) != null && !line.isEmpty(); ) {
                if ((length += line.length()) > 16_384) return;
                int colon = line.indexOf(':');
                if (colon > 0) incoming.put(line.substring(0, colon).toLowerCase(java.util.Locale.ROOT), line.substring(colon + 1).trim());
            }
            String path = request[1];
            if (!path.startsWith(prefix)) { headers(out, 404, "text/plain", 0, null); return; }
            String id = path.substring(prefix.length());
            String target;
            synchronized (resources) { target = resources.get(id); }
            if (!id.equals("master.m3u8") && target == null) { headers(out, 404, "text/plain", 0, null); return; }
            lastRequest = System.currentTimeMillis();
            for (int attempt = 0; attempt < 2; attempt++) {
                URL url = new URL(source.resolve(target, attempt > 0));
                upstream = (HttpURLConnection) url.openConnection();
                upstream.setConnectTimeout(10_000);
                upstream.setReadTimeout(20_000);
                upstream.setRequestProperty("User-Agent", "Mozilla/5.0");
                upstream.setRequestProperty("Accept-Encoding", "identity");
                if (incoming.containsKey("range")) upstream.setRequestProperty("Range", incoming.get("range"));
                if (request[0].equals("HEAD")) upstream.setRequestMethod("HEAD");
                int status = upstream.getResponseCode();
                if ((status == 401 || status == 403) && attempt == 0) { upstream.disconnect(); continue; }
                String type = upstream.getContentType();
                boolean playlist = url.getPath().endsWith(".m3u8") || (type != null && type.toLowerCase(java.util.Locale.ROOT).contains("mpegurl"));
                if (status >= 200 && status < 300 && playlist && !request[0].equals("HEAD")) {
                    byte[] data;
                    try (InputStream in = upstream.getInputStream()) { data = rewrite(read(in, 2_000_000), upstream.getURL()); }
                    headers(out, status, "application/vnd.apple.mpegurl", data.length, null);
                    out.write(data);
                } else {
                    headers(out, status, type == null ? "application/octet-stream" : type,
                            upstream.getContentLengthLong(), upstream.getHeaderField("Content-Range"));
                    if (!request[0].equals("HEAD") && status < 400) {
                        try (InputStream in = upstream.getInputStream()) {
                            byte[] buffer = new byte[32_768];
                            for (int n; (n = in.read(buffer)) >= 0; ) out.write(buffer, 0, n);
                        }
                    }
                }
                break;
            }
        } catch (IOException | RuntimeException ignored) {
            // Kodi retries live playlist/segment requests; socket closure also covers the user stopping playback.
        } finally {
            if (upstream != null) upstream.disconnect();
        }
    }

    static byte[] read(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int n; (n = in.read(buffer)) >= 0; ) {
            if (out.size() + n > limit) throw new IOException("Live playlist response too large");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    private static void headers(OutputStream out, int status, String type, long size, String range) throws IOException {
        String header = "HTTP/1.1 " + status + " Stream\r\nContent-Type: " + type + "\r\nConnection: close\r\nCache-Control: no-store\r\n";
        if (size >= 0) header += "Content-Length: " + size + "\r\n";
        if (range != null) header += "Content-Range: " + range + "\r\nAccept-Ranges: bytes\r\n";
        out.write((header + "\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    @Override public void close() {
        closed = true;
        try { server.close(); } catch (IOException ignored) { }
        workers.shutdownNow();
    }
}
