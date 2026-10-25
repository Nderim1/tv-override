package com.nde.kodirows;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Runs on the desktop JDK, with a real HTTP origin and proxy; no TV or external services needed. */
public final class HlsProxyTest {
    static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(3000);
        try { return new String(HlsProxy.read(c.getInputStream(), 1_000_000), StandardCharsets.UTF_8); }
        finally { c.disconnect(); }
    }
    static String media(String playlist) {
        for (String line : playlist.split("\n")) if (!line.isEmpty() && !line.startsWith("#")) return line;
        throw new AssertionError("Missing media URL");
    }

    public static void main(String[] args) throws Exception {
        AtomicInteger accepted = new AtomicInteger(1), token = new AtomicInteger(1), forced = new AtomicInteger();
        HttpServer origin = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
        String root = "http://127.0.0.1:" + origin.getAddress().getPort();
        origin.createContext("/", exchange -> {
            if (!("t=" + accepted.get()).equals(exchange.getRequestURI().getQuery())) {
                exchange.sendResponseHeaders(403, -1);
                exchange.close();
                return;
            }
            String path = exchange.getRequestURI().getPath(), text;
            if (path.equals("/master.m3u8")) {
                text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant/index.m3u8?t=old\n";
            } else if (path.endsWith(".m3u8")) {
                text = "#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:100\n"
                        + "#EXT-X-KEY:METHOD=AES-128,URI=\"" + root + "/key.bin?t=old\"\n"
                        + "#EXT-X-MAP:URI=\"init.mp4?t=old\"\n#EXTINF:6,\nsegment.ts?t=old\n";
            } else {
                text = "media-token-" + accepted.get();
            }
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", path.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
            if (exchange.getRequestMethod().equals("HEAD")) {
                exchange.getResponseHeaders().set("Content-Length", String.valueOf(bytes.length));
                exchange.sendResponseHeaders(200, -1);
            } else if (exchange.getRequestHeaders().containsKey("Range")) {
                exchange.getResponseHeaders().set("Content-Range", "bytes 0-4/" + bytes.length);
                exchange.sendResponseHeaders(206, 5);
                exchange.getResponseBody().write(bytes, 0, 5);
            } else {
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            }
            exchange.close();
        });
        origin.start();
        try (HlsProxy proxy = new HlsProxy((url, force) -> {
            if (force) { token.set(accepted.get()); forced.incrementAndGet(); }
            String target = url == null ? root + "/master.m3u8?t=old" : url;
            return target.replaceAll("([?&]t=)[^&]*", "$1" + token.get());
        })) {
            String master = get(proxy.url());
            check(!master.contains("?t="), "Master leaked upstream signature");
            String variantUrl = media(master), variant = get(variantUrl);
            check(variant.contains("#EXT-X-MEDIA-SEQUENCE:100"), "Playlist sequence changed");
            Matcher attrs = Pattern.compile("URI=\"([^\"]+)\"").matcher(variant);
            int attributes = 0;
            while (attrs.find()) {
                check(attrs.group(1).startsWith(proxy.url().substring(0, proxy.url().lastIndexOf('/') + 1)), "Attribute bypassed relay");
                check(get(attrs.group(1)).equals("media-token-1"), "KEY/MAP not relayed");
                attributes++;
            }
            check(attributes == 2, "Missing KEY/MAP attribute");
            String segment = media(variant);
            check(get(segment).equals("media-token-1"), "Segment failed");
            accepted.set(2);  // old signature has expired while Kodi keeps its original playback URLs
            check(get(segment).equals("media-token-2"), "Expiry renewal failed");
            check(forced.get() == 1, "Expected one renewal after 403");
            check(get(variantUrl).contains("#EXT-X-MEDIA-SEQUENCE:100"), "Old variant URL stopped working after renewal");
            HttpURLConnection range = (HttpURLConnection) new URL(segment).openConnection();
            range.setRequestProperty("Range", "bytes=0-4");
            check(range.getResponseCode() == 206 && "bytes 0-4/13".equals(range.getHeaderField("Content-Range")), "Range not preserved");
            check(new String(HlsProxy.read(range.getInputStream(), 100), StandardCharsets.UTF_8).equals("media"), "Range body wrong");
            range.disconnect();
            HttpURLConnection head = (HttpURLConnection) new URL(segment).openConnection();
            head.setRequestMethod("HEAD");
            check(head.getResponseCode() == 200 && head.getContentLengthLong() == 13, "HEAD failed");
            head.disconnect();
            HttpURLConnection missing = (HttpURLConnection) new URL(proxy.url().replace("master.m3u8", "unknown")).openConnection();
            check(missing.getResponseCode() == 404, "Unregistered resource accepted");
            missing.disconnect();
            System.out.println("Passed HLS relay: master, variants, segments, KEY/MAP, expired signatures, Range, HEAD, unknown resources.");
        } finally { origin.stop(0); }
    }
}
