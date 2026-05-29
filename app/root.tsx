import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        {/*
          App Bridge is injected (with the api key) by <AppProvider embedded>
          in app/routes/app.tsx — it renders the keyed app-bridge.js followed by
          polaris.js. Do NOT add a manual <script src="app-bridge.js"> here: an
          unkeyed copy in <head> boots App Bridge with no API key first, leaving
          the keyed copy a no-op duplicate, which breaks the embedded session and
          leaves the s-* web components inert. (Matches the official template.)
        */}
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
