import { BrandResponse, UpdateBrandRequest } from "@baize/shared";
import { brand, replaceBrand } from "../state.js";
import { readBody, send, type Route } from "./http.js";

export const brandRoutes: Route = async ({ req, res, path, method, push }) => {
  if (path !== "/api/brand") return false;
  if (method === "GET") {
    send(res, 200, BrandResponse.parse({ brand: brand.current }));
    return true;
  }
  if (method !== "PUT") return false;
  const parsed = UpdateBrandRequest.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: parsed.error.issues[0]?.message ?? "请求体不合法" });
    return true;
  }
  const outcome = replaceBrand(parsed.data);
  if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
  else {
    push({ type: "brand_updated", brand: outcome.value });
    send(res, 200, BrandResponse.parse({ brand: outcome.value }));
  }
  return true;
};
