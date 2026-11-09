import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Static assets and uploaded scans are served outside the locale prefix.
  matcher: ["/((?!api|_next|_vercel|media|.*\\..*).*)"],
};
