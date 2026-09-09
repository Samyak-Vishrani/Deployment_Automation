"use client";

import { createContext, useContext, type ReactNode } from "react";
import { getPlatformProvider } from "./index";
import type { PlatformProvider as PlatformProviderContract } from "./types";

const PlatformContext = createContext<PlatformProviderContract | null>(null);

export function PlatformProvider({ children }: { children: ReactNode }) {
  return <PlatformContext.Provider value={getPlatformProvider()}>{children}</PlatformContext.Provider>;
}

export function usePlatform() {
  const value = useContext(PlatformContext);
  if (!value) {
    throw new Error("usePlatform must be used inside PlatformProvider");
  }
  return value;
}
