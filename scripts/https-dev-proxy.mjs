import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const targetHost = process.env.TRYONAI_TARGET_HOST ?? "::1";
const targetPort = Number(process.env.TRYONAI_TARGET_PORT ?? 3000);
const listenPort = Number(process.env.TRYONAI_PROXY_PORT ?? 3458);

const options = {
  key: fs.readFileSync(".shopify/localhost-key.pem"),
  cert: fs.readFileSync(".shopify/localhost.pem"),
};

const server = https.createServer(options, (req, res) => {
  const proxyReq = http.request(
    {
      host: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, {
        ...proxyRes.headers,
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
        "access-control-allow-private-network": "true",
      });
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
    });
    res.end(JSON.stringify({ error: `Dev proxy failed: ${error.message || String(error)}` }));
  });

  req.pipe(proxyReq);
});

server.listen(listenPort, () => {
  console.log(`HTTPS dev proxy listening on https://localhost:${listenPort}`);
  console.log(`Forwarding requests to http://${targetHost}:${targetPort}`);
});
