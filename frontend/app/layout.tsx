import type { Metadata } from "next";
import "./globals.css";
import { PlatformProvider } from "@/lib/platform/context";

export const metadata: Metadata = {
  title: "OrbitOps | Developer platform",
  description: "A unified control plane for application delivery and operations.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PlatformProvider>{children}</PlatformProvider>
      </body>
    </html>
  );
}
