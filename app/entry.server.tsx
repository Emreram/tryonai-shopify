import {
  handleRequest as vercelHandleRequest,
  type RenderOptions,
} from "@vercel/react-router/entry.server";
import type { AppLoadContext, EntryContext } from "react-router";
import { addDocumentResponseHeaders } from "./shopify.server";

export { streamTimeout } from "@vercel/react-router/entry.server";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  loadContext?: AppLoadContext,
  options?: RenderOptions
) {
  addDocumentResponseHeaders(request, responseHeaders);
  return vercelHandleRequest(
    request,
    responseStatusCode,
    responseHeaders,
    reactRouterContext,
    loadContext,
    options
  );
}
