package com.nde.kodirows;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Kodi JSON-RPC over TCP on this device (127.0.0.1:9090). Kodi turns this on by default for apps on the same
 * system ("Allow remote control from applications on this system"), with no password. The stream has no
 * framing: whole JSON objects back to back, with notifications mixed in, so replies are matched by id.
 */
final class Kodi implements Closeable {
    private final Socket socket;
    private final BufferedReader in;
    private final OutputStream out;
    private int nextId = 1;

    Kodi(int port, int readTimeoutMs) throws IOException {
        socket = new Socket();
        socket.connect(new InetSocketAddress("127.0.0.1", port), 2000);
        socket.setSoTimeout(readTimeoutMs);
        in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        out = socket.getOutputStream();
    }

    /** True when Kodi is running and answers. */
    static boolean ping(int port) {
        try (Kodi kodi = new Kodi(port, 3000)) {
            return "pong".equals(kodi.call("JSONRPC.Ping", null));
        } catch (IOException e) {
            return false;
        }
    }

    /** The call's "result"; throws IOException for transport errors and Kodi errors. */
    Object call(String method, JSONObject params) throws IOException {
        int id = nextId++;
        try {
            JSONObject req = new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method);
            if (params != null) req.put("params", params);
            out.write(req.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            while (true) {
                JSONObject msg = readObject();
                if (msg.optInt("id", -1) != id) continue;  // a notification or another reply
                JSONObject err = msg.optJSONObject("error");
                if (err != null) throw new IOException("Kodi " + method + ": " + err.optString("message") + " " + err.opt("data"));
                return msg.opt("result");
            }
        } catch (JSONException e) {
            throw new IOException("Kodi sent bad JSON: " + e.getMessage());
        }
    }

    private JSONObject readObject() throws IOException, JSONException {
        StringBuilder sb = new StringBuilder();
        int depth = 0;
        boolean str = false, esc = false;
        while (true) {
            int c = in.read();
            if (c < 0) throw new EOFException("Kodi closed the connection");
            if (depth == 0 && c != '{') continue;
            sb.append((char) c);
            if (str) {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') str = false;
            } else if (c == '"') {
                str = true;
            } else if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return new JSONObject(sb.toString());
            }
        }
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }
}
