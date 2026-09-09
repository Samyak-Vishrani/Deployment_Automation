import { HttpPlatformProvider } from "./http-provider";
import { MockPlatformProvider } from "./mock-provider";
import type { PlatformProvider } from "./types";

let provider: PlatformProvider | null = null;

export function getPlatformProvider() {
  if (!provider) {
    provider = process.env.NEXT_PUBLIC_DATA_MODE === "api" ? new HttpPlatformProvider() : new MockPlatformProvider();
  }
  return provider;
}

export * from "./types";
