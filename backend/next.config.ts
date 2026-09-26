import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Kept out of the server bundle.
   *
   * dockerode opens a named pipe / unix socket and tar writes to disk; both use
   * dynamic requires and native-ish paths that webpack either mangles or
   * inlines incorrectly. Listing them here makes Next require() them from
   * node_modules at runtime, which is what they expect.
   */
  serverExternalPackages: ["dockerode", "tar", "@prisma/client"],
};

export default nextConfig;
